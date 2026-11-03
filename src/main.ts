/*
 * Copyright (c) 2018-2024 bluefox <dogafox@gmail.com> CC-BY-NC-4.0
 * Copyright (c) 2025-2026 bluefox <dogafox@gmail.com> MIT
 */
import * as utils from '@iobroker/adapter-core';
import { LCN, SCAN_STEP } from './lib/lcn';
import { COMMANDS } from './lib/cmds';
import { convertVariable } from './lib/variables';
import {
    LcnDeviceManagement,
    type LcnAdapterApi,
    type LcnDevice,
    type LcnDeviceSettings,
} from './lib/DeviceManagement';
import type {
    FoundModule,
    FoundModules,
    LcnDeviceNative,
    LcnLogger,
    LcnState,
    LcnStateNative,
    ReadTask,
    ScanProgress,
    ScanResultInfo,
} from './lib/types';

// e.g. lcn.0.S000.M180.SUMS.SUMSUM1000_undefined, created by versions <= 3.0.1
const INVALID_SUM_ID = /\.SUMS\.SUM[^.]*_undefined$/;

/** Object created by the adapter. The ID is relative to the namespace, except for objects of `recalculateRelays` */
type NewObject = (ioBroker.SettableChannelObject | ioBroker.SettableStateObject | ioBroker.SettableDeviceObject) & {
    _id: string;
};

interface ObjectTask {
    id: string;
    name: 'create' | 'delete';
    obj?: NewObject;
}

interface StateToWrite {
    id: string;
    val: ioBroker.StateValue | undefined;
}

function formatNumber(addr: number | string): string {
    const num = parseInt(addr as string, 10);
    if (num < 10) {
        return `00${num}`;
    }
    if (num < 100) {
        return `0${num}`;
    }
    if (num > 255) {
        throw new Error(`Invalid address ${num}`);
    }
    return num.toString();
}

function getAddress(segment: number | string, module: number | string): string {
    return `S${formatNumber(segment)}.M${formatNumber(module)}`;
}

function paddingZero(num: number | string | undefined): string {
    if (Number(num) < 10) {
        return `0${num}`;
    }
    return String(num);
}

function createChannel(
    segment: number,
    module: number,
    deviceName: string,
    channelName: string,
): ioBroker.SettableChannelObject & { _id: string } {
    const id = getAddress(segment, module);

    const _id = `${id}.${channelName}S`;

    return {
        _id,
        common: {
            name: `${deviceName} ${channelName.toLowerCase()}s`,
        },
        type: 'channel',
        native: {
            segment,
            module,
            command: channelName,
        },
    };
}

function createAnalogState(
    segment: number,
    module: number,
    deviceName: string,
    input: number | string | undefined,
): ioBroker.SettableStateObject & { _id: string } {
    const id = getAddress(segment, module);
    const _id = `${id}.${COMMANDS.ANALOG_OUT.name}S`;

    const _sid = `${_id}.${COMMANDS.ANALOG_OUT.name}${paddingZero(input)}`;

    return {
        _id: _sid,
        common: {
            name: `${deviceName} ANALOG ${input}`,
            type: 'number',
            role: 'level.dimmer',
            min: 0,
            max: 100,
            write: true,
            read: true,
        },
        type: 'state',
        native: {
            segment,
            module,
            command: COMMANDS.ANALOG_OUT.name,
            output: input,
        },
    };
}

function createNumberState(
    segment: number,
    module: number,
    deviceName: string,
    channelName: string,
    input: number | string | undefined,
    write?: boolean,
    limit?: number,
): ioBroker.SettableStateObject & { _id: string } {
    const id = getAddress(segment, module);
    const _id = `${id}.${channelName}S`;

    const _sid = `${_id}.${channelName}${paddingZero(input)}${limit !== undefined ? `_${paddingZero(limit)}` : ''}`;

    return {
        _id: _sid,
        common: {
            name: `${deviceName} ${channelName.toLowerCase()} ${input}`,
            desc: write ? 'By writing of the state the actual value will be read from device' : undefined,
            type: 'number',
            role: 'value',
            write: write || false,
            read: true,
        },
        type: 'state',
        native: {
            segment,
            module,
            command: channelName,
            output: input,
        },
    };
}

function createBooleanState(
    segment: number,
    module: number,
    deviceName: string,
    channelName: string,
    input: number | string | undefined,
    write?: boolean,
): ioBroker.SettableStateObject & { _id: string } {
    const id = getAddress(segment, module);
    const _id = `${id}.${channelName}S`;

    const _sid = `${_id}.${channelName}${paddingZero(input)}`;

    return {
        _id: _sid,
        common: {
            name: `${deviceName} ${channelName.toLowerCase()} ${input}`,
            desc: write ? 'By writing of the state the actual value will be read from device' : undefined,
            type: 'boolean',
            role: 'switch',
            write: write || false,
            read: true,
        },
        type: 'state',
        native: {
            segment,
            module,
            command: channelName,
            output: input,
        },
    };
}

export class LcnAdapter extends utils.Adapter implements LcnAdapterApi {
    private lcn: LCN | null = null;
    private lcnConnected = false;
    /** Cache of all own objects of the modules (lcn.0.S...), key is the full ID */
    private objects: Record<string, ioBroker.Object> = {};
    private statusReadDone = false;
    private readonly scan: ScanProgress = { step: SCAN_STEP.INACTIVE, progress: 0, found: 0 };
    private recalculateRelaysTimer: ioBroker.Timeout | undefined;
    private scanListener: ((progress: ScanProgress) => void) | null = null;
    private deviceManagement: LcnDeviceManagement | null = null;
    /** Timer of the cyclic read of the variables */
    private varPollTimer: ioBroker.Timeout | undefined;
    /** The status read of all modules (readAll) is running */
    private statusReadRunning = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'lcn',
        });
        this.on('ready', () =>
            this.onReady().catch(e => this.log.error(`Cannot start: ${(e as Error).stack || String(e)}`)),
        );
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
        this.on('objectChange', (id, obj) => this.onObjectChange(id, obj));
        this.on('message', obj => this.onMessage(obj));
        this.on('unload', callback => this.onUnload(callback));
    }

    /** is called when adapter shuts down - callback has to be called under any circumstances! */
    private onUnload(callback: () => void): void {
        try {
            if (this.recalculateRelaysTimer) {
                this.clearTimeout(this.recalculateRelaysTimer);
                this.recalculateRelaysTimer = undefined;
            }
            if (this.varPollTimer) {
                this.clearTimeout(this.varPollTimer);
                this.varPollTimer = undefined;
            }
            if (this.lcnConnected) {
                void this.setState('info.connection', false, true);
                this.lcnConnected = false;
            }
            if (this.lcn) {
                this.lcn.destroy(callback);
                this.lcn = null;
            } else {
                callback();
            }
        } catch {
            callback();
        }
    }

    private get lcnConnection(): LCN {
        if (!this.lcn) {
            throw new Error('LCN is not started');
        }
        return this.lcn;
    }

    /** is called if a subscribed state changes */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        // you can use the ack flag to detect if it is status (true) or command (false)
        if (!state || state.ack) {
            return;
        }
        if (id.startsWith(`${this.namespace}.S`)) {
            this.getCachedObject(id)
                .then(obj =>
                    this.lcnConnection
                        .control(
                            obj.native.segment,
                            obj.native.module,
                            obj.native.command,
                            obj.native.output,
                            state.val,
                        )
                        .then(() => this.log.debug('Command sent'))
                        .catch(e =>
                            this.log.error(
                                `Cannot send ${obj.native.segment}:${obj.native.module}(${obj.native.command}, out=${obj.native.output}, val="${state.val}"): ${e}`,
                            ),
                        ),
                )
                .catch(e => this.log.warn(`Cannot control ${id}: ${e}`));
        } else if (id.match(/scan\.manual$/)) {
            if (!state.val) {
                this.log.debug('Received empty scan command. Ignored.');
            } else if (state.val === '*') {
                this.readAll();
            } else {
                const m = String(state.val).match(/S?(\d+):(\d+):?(\w)?/i);
                if (m && m.length > 2) {
                    const segment = parseInt(m[1], 10);
                    const module = parseInt(m[2], 10);
                    const op = (m[3] || 'AR').toUpperCase();
                    if (
                        !op ||
                        (op !== 'R' &&
                            op !== 'L' &&
                            op !== 'A' &&
                            op !== 'AR' &&
                            op !== 'RA' &&
                            op !== 'S' &&
                            op !== 'V' &&
                            op !== 'C' &&
                            op !== 'SE')
                    ) {
                        // Modules with LEDs are read without sensors
                        this.getCachedObject(`${this.namespace}.${getAddress(segment, module)}`)
                            .catch(() => null)
                            .then(obj => this.lcnConnection.read(segment, module, obj?.native.leds ? 'AR' : op))
                            .catch(e => this.log.warn(`Cannot read ${segment}:${module}: ${e}`));
                    } else if (op === 'V') {
                        // Modules with firmware before 170206 know only 3 variables and need other commands
                        this.getCachedObject(`${this.namespace}.${getAddress(segment, module)}`)
                            .catch(() => null)
                            .then(obj => {
                                if ((obj?.native as LcnDeviceNative | undefined)?.typelessVars) {
                                    return this.lcnConnection.readVariables(segment, module, [1, 2, 3], true);
                                }
                                this.lcnConnection.read(segment, module, op);
                            })
                            .catch(e => this.log.warn(`Cannot read ${segment}:${module}: ${e}`));
                    } else {
                        this.lcnConnection.read(segment, module, op);
                    }
                } else {
                    this.log.warn(
                        `Invalid read command ${state.val}. Expected S0:6S => Segment 0, module 6, read status`,
                    );
                }
            }
        }
    }

    private onMessage(obj: ioBroker.Message): void {
        if (!obj) {
            return;
        }
        // Commands of the device manager (dm:...) are processed by @iobroker/dm-utils
        switch (obj.command) {
            case 'scanOne':
            case 'scan': {
                // segment: 0 = own segment, otherwise the ID of the segment (since 4.0.0)
                const message = obj.message as { max?: string; segment?: number | string } | undefined;
                this.scanRange(String(message?.max ?? ''), parseInt(String(message?.segment ?? 0), 10) || 0)
                    .then(info => obj.callback && this.sendTo(obj.from, obj.command, info, obj.callback))
                    .catch(error => {
                        this.log.error(`Cannot scan: ${error}`);
                        if (obj.callback) {
                            // The LCN library rejects with strings, keep them as they are
                            const text = error instanceof Error ? error.message : error;
                            this.sendTo(obj.from, obj.command, { error: text }, obj.callback);
                        }
                    });
                break;
            }

            case 'getAll': {
                const devices = this.getLcnDevices().map(device => ({
                    id: `${this.namespace}.${device.id}`,
                    native: device.native,
                    common: device.common,
                }));
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, devices, obj.callback);
                }
                break;
            }
        }
    }

    private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        if (id && obj) {
            const oldObj = this.objects[id];
            if (
                oldObj?.common &&
                obj.type === 'state' &&
                obj.native?.command === COMMANDS.VAR.name &&
                obj.common?.role !== oldObj.common.role
            ) {
                // The role defines the conversion of the variable: read the raw value again from the module.
                // Before 4.0.0 the current (already converted) value was converted again, and only if
                // the object had no role before.
                const native = obj.native as LcnStateNative;
                const input = parseInt(String(native.output), 10);
                const device = this.objects[`${this.namespace}.${getAddress(native.segment, native.module)}`];
                if (input && this.lcn?.isConnected()) {
                    // The new object is in the cache, when the answer arrives
                    this.lcn
                        .readVariables(
                            native.segment,
                            native.module,
                            [input],
                            !!(device?.native as LcnDeviceNative | undefined)?.typelessVars,
                        )
                        .catch(e => this.log.warn(`Cannot read ${id}: ${e}`));
                }
            }
            if (obj.type === 'device') {
                // create relays output
                if (this.recalculateRelaysTimer) {
                    this.clearTimeout(this.recalculateRelaysTimer);
                }
                this.recalculateRelaysTimer = this.setTimeout(() => {
                    this.recalculateRelaysTimer = undefined;
                    this.recalculateRelays().catch(e => this.log.error(`Cannot recalculate relays: ${e}`));
                }, 1000);
            }
            // store new object
            this.objects[id] = obj;
        } else if (id) {
            // if object deleted
            delete this.objects[id];
        }
    }

    private async processTasks(tasks: ObjectTask[]): Promise<void> {
        for (const task of tasks) {
            if (task.name === 'create' && task.obj) {
                this.log.info(`Create state ${task.id}`);
                try {
                    await this.setForeignObjectAsync(task.id, task.obj);
                } catch (e) {
                    this.log.warn(`Cannot create ${task.id}: ${e}`);
                }
                this.objects[task.id] = task.obj;
            } else if (task.name === 'delete') {
                this.log.info(`Delete state ${task.id}`);
                delete this.objects[task.id];
                try {
                    await this.delForeignObjectAsync(task.id);
                } catch (e) {
                    this.log.debug(`Cannot delete ${task.id}: ${e}`);
                }
            }
        }
    }

    /** Create or delete the states that cannot be detected by the scan: output relays, display and regulators */
    private async recalculateRelays(): Promise<void> {
        const ids = Object.keys(this.objects);

        const tasks: ObjectTask[] = [];

        const RELAY_NAME = this.config.combinedRelays ? COMMANDS.RELAY_IN.name : COMMANDS.RELAY_OUT.name;

        ids.forEach(id => {
            const deviceObj = this.objects[id];
            if (deviceObj.type !== 'device' || !deviceObj.native) {
                return;
            }
            const device = deviceObj.native as LcnDeviceNative;
            // check if some relays must be created od deleted
            // find all RELAYS_OUT for this device
            let channelId = `${id}.${RELAY_NAME}S`; // lcn.0.S000.M010.RELAY_OUTS
            let name = `${channelId}.${RELAY_NAME}0`; // lcn.0.S000.M010.RELAY_OUTS.RELAY_OUT0
            const relays = ids.filter(_id => _id.includes(name));
            let relaysOut = device.relaysOut || 0;
            if (this.config.combinedRelays) {
                relaysOut = Math.max(device.relays || 0, relaysOut);
            }

            // delete all RELAYS_OUT, because not required
            if (this.config.combinedRelays) {
                const channelOutId = `${id}.${COMMANDS.RELAY_OUT.name}S`;
                const nameOut = `${channelOutId}.${COMMANDS.RELAY_OUT.name}0`; // lcn.0.S000.M010.RELAY_OUTS.RELAY_OUT0
                const relaysOutList = ids.filter(_id => _id.includes(nameOut));
                if (relaysOutList.length) {
                    relaysOutList.sort();
                    relaysOutList.forEach(_id => tasks.push({ id: _id, name: 'delete' }));
                    // delete channel too
                    tasks.push({ id: channelOutId, name: 'delete' });
                }
            }

            if (relays.length !== relaysOut) {
                relays.sort();
                if (relays.length > relaysOut) {
                    // Must be deleted
                    // delete Objects
                    for (let i = relaysOut; i < relays.length; i++) {
                        tasks.push({ id: relays[i], name: 'delete' });
                    }
                    // delete channel
                    if (!relaysOut && this.objects[channelId]) {
                        tasks.push({ id: channelId, name: 'delete' });
                    }
                } else {
                    if (!this.objects[channelId]) {
                        tasks.push({
                            id: channelId,
                            name: 'create',
                            obj: {
                                _id: channelId,
                                common: {
                                    name: 'Output relays',
                                },
                                type: 'channel',
                                native: {},
                            },
                        });
                    }

                    // Must be created
                    for (let i = relays.length; i < relaysOut && i < 8; i++) {
                        const _id = `${name}${i + 1}`;
                        tasks.push({
                            id: _id,
                            name: 'create',
                            obj: {
                                _id,
                                common: {
                                    name: `Output relay ${i + 1}`,
                                    role: 'switch',
                                    type: 'boolean',
                                    write: true,
                                    read: false,
                                    def: false,
                                },
                                native: {
                                    segment: device.segment,
                                    module: device.module,
                                    command: COMMANDS.RELAY_OUT.name,
                                    output: i + 1,
                                },
                                type: 'state',
                            },
                        });
                    }
                }
            }

            // display
            const displayOut = device.display || false;
            channelId = `${id}.${COMMANDS.DISPLAY_OUT.name}S`; // lcn.0.S000.M010.DISPLAY_OUT
            name = `${channelId}.${COMMANDS.DISPLAY_OUT.name}0`; // lcn.0.S000.M010.DISPLAY_OUT.DISPLAY_OUT0
            const display = !!ids.find(_id => _id.startsWith(name));

            if (display !== displayOut) {
                if (!displayOut) {
                    // display must be deleted
                    tasks.push({ id: channelId, name: 'delete' });
                    for (let i = 1; i <= 4; i++) {
                        tasks.push({ id: name + i, name: 'delete' });
                    }
                } else {
                    // display must be created
                    if (!this.objects[channelId]) {
                        tasks.push({
                            id: channelId,
                            name: 'create',
                            obj: {
                                _id: channelId,
                                common: {
                                    name: { en: 'Display output', de: 'Display-Ausgang' },
                                },
                                type: 'channel',
                                native: {},
                            },
                        });
                    }
                    for (let i = 1; i <= 4; i++) {
                        tasks.push({
                            id: name + i,
                            name: 'create',
                            obj: {
                                _id: name + i,
                                common: {
                                    name: { en: `Display line ${i}`, de: `Display-Zeile ${i}` },
                                    role: 'state',
                                    type: 'string',
                                    write: true,
                                    read: false,
                                    def: '',
                                },
                                native: {
                                    segment: device.segment,
                                    module: device.module,
                                    command: COMMANDS.DISPLAY_OUT.name,
                                    output: i,
                                },
                                type: 'state',
                            },
                        });
                    }
                }
            }

            // regulators
            // The scan stores the number of regulators, the settings a boolean
            const regulatorOut = !!device.regulator;
            channelId = `${id}.${COMMANDS.REGULATOR_OUT.name}S`; // lcn.0.S000.M010.REGULATOR_OUT
            name = `${channelId}.${COMMANDS.REGULATOR_OUT.name}0`; // lcn.0.S000.M010.REGULATOR_OUT.REGULATOR0
            const regulator = !!ids.find(_id => _id.startsWith(name));

            if (regulator !== regulatorOut) {
                if (!regulatorOut) {
                    // regulators must be deleted
                    tasks.push({ id: channelId, name: 'delete' });
                    for (let i = 1; i <= 2; i++) {
                        tasks.push({ id: name + i, name: 'delete' });
                    }
                } else {
                    // regulators must be created
                    if (!this.objects[channelId]) {
                        tasks.push({
                            id: channelId,
                            name: 'create',
                            obj: {
                                _id: channelId,
                                common: {
                                    name: { en: 'Regulator output', de: 'Regler-Ausgänge' },
                                },
                                type: 'channel',
                                native: {},
                            },
                        });
                    }
                    for (let i = 1; i <= 2; i++) {
                        tasks.push({
                            id: name + i,
                            name: 'create',
                            obj: {
                                _id: name + i,
                                common: {
                                    name: { en: `Regulator output ${i}`, de: `Regler-Ausgang ${i}` },
                                    role: 'level.temperature',
                                    unit: '°C',
                                    type: 'number',
                                    write: true,
                                    read: true,
                                },
                                native: {
                                    segment: device.segment,
                                    module: device.module,
                                    command: COMMANDS.REGULATOR_OUT.name,
                                    output: i,
                                },
                                type: 'state',
                            },
                        });
                    }
                }
            }

            // regulator locks
            channelId = `${id}.${COMMANDS.REGULATOR_LOCK_OUT.name}S`; // lcn.0.S000.M010.REGULATOR_LOCK_OUT
            name = `${channelId}.${COMMANDS.REGULATOR_LOCK_OUT.name}0`; // lcn.0.S000.M010.REGULATOR_LOCK_OUT.REGULATOR_LOCK_OUT0
            const regulatorLock = !!ids.find(_id => _id.startsWith(name));

            if (regulatorLock !== regulatorOut) {
                if (!regulatorOut) {
                    // regulators must be deleted
                    tasks.push({ id: channelId, name: 'delete' });
                    for (let i = 1; i <= 2; i++) {
                        tasks.push({ id: name + i, name: 'delete' });
                    }
                } else {
                    // regulators must be created
                    if (!this.objects[channelId]) {
                        tasks.push({
                            id: channelId,
                            name: 'create',
                            obj: {
                                _id: channelId,
                                common: {
                                    name: { en: 'Regulator locks', de: 'Regler-Sperren' },
                                },
                                type: 'channel',
                                native: {},
                            },
                        });
                    }
                    for (let i = 1; i <= 2; i++) {
                        tasks.push({
                            id: name + i,
                            name: 'create',
                            obj: {
                                _id: name + i,
                                common: {
                                    name: { en: `Regulator lock ${i}`, de: `Regler-Sperre ${i}` },
                                    role: 'switch',
                                    type: 'boolean',
                                    write: true,
                                    read: false,
                                    def: false,
                                },
                                native: {
                                    segment: device.segment,
                                    module: device.module,
                                    command: COMMANDS.REGULATOR_LOCK_OUT.name,
                                    output: i,
                                },
                                type: 'state',
                            },
                        });
                    }
                }
            }
        });

        await this.processTasks(tasks);
    }

    /** Get the object from the cache or from the DB. Throws if it does not exist */
    private async getCachedObject(id: string): Promise<ioBroker.Object> {
        if (this.objects[id]) {
            return this.objects[id];
        }
        const obj = await this.getForeignObjectAsync(id);
        if (!obj) {
            throw new Error('Not found');
        }
        this.objects[id] = obj;
        return obj;
    }

    /** Create the objects, that do not exist yet. The IDs are relative to the namespace */
    private async writeObjs(objs: NewObject[]): Promise<void> {
        for (const obj of objs) {
            const oldObj = await this.getObjectAsync(obj._id);
            if (!oldObj) {
                this.objects[`${this.namespace}.${obj._id}`] = obj;

                await this.setObjectAsync(obj._id, obj);
            } else {
                this.objects[oldObj._id] = oldObj;
            }
        }
    }

    private async writeStates(states: StateToWrite[]): Promise<void> {
        for (const state of states) {
            if (state.val !== undefined) {
                await this.setStateAsync(state.id, state.val, true);
            }
        }
    }

    /**
     * Create or update the objects of a module found by the scan
     *
     * @param device the found module
     * @returns true if the module is new
     */
    private async createModuleObjects(device: FoundModule): Promise<boolean> {
        const segment = device.segment!;
        const module = device.module!;
        const id = getAddress(segment, module);
        const obj = await this.getObjectAsync(id);
        const isNew = !obj;
        const objs: NewObject[] = [];
        const states: StateToWrite[] = [];
        /** Values of the variables, they must be converted depending on the role */
        const variables: StateToWrite[] = [];
        const native: Partial<Record<keyof LcnDeviceNative, number | boolean>> = {};
        const deviceStates = device.states || [];

        const comment = device.comment || device.hwType;
        const name = device.name + (comment ? ` (${comment})` : '');

        /** Count the states of one type in the native of the device */
        const count = (
            attr: 'analogs' | 'vars' | 'counters' | 'limits' | 'regulator' | 'relays' | 'leds' | 'sensors',
        ): void => {
            native[attr] ||= 0;
            (native[attr] as number)++;
        };
        const statesOf = (type: string): LcnState[] => deviceStates.filter(state => state.type === type);

        // process analog out
        if (statesOf(COMMANDS.ANALOG_IN.name).length) {
            objs.push(createChannel(segment, module, device.name, COMMANDS.ANALOG_IN.name));

            statesOf(COMMANDS.ANALOG_IN.name).forEach(state => {
                count('analogs');
                const stateObj = createAnalogState(segment, module, device.name, state.input);
                objs.push(stateObj);
                states.push({ id: stateObj._id, val: state.status });
            });
        }

        // process variables
        if (statesOf(COMMANDS.VAR.name).length) {
            objs.push(createChannel(segment, module, device.name, COMMANDS.VAR.name));

            statesOf(COMMANDS.VAR.name).forEach(state => {
                count('vars');
                const stateObj = createNumberState(segment, module, device.name, COMMANDS.VAR.name, state.input, true);
                objs.push(stateObj);
                // raw value, converted by updateVariable depending on the role of the (maybe existing) state
                variables.push({ id: stateObj._id, val: state.status });
            });
        }

        // process counters
        if (statesOf(COMMANDS.COUNTER.name).length) {
            objs.push(createChannel(segment, module, device.name, COMMANDS.COUNTER.name));

            statesOf(COMMANDS.COUNTER.name).forEach(state => {
                count('counters');
                const stateObj = createNumberState(
                    segment,
                    module,
                    device.name,
                    COMMANDS.COUNTER.name,
                    state.input,
                    true,
                );
                objs.push(stateObj);
                states.push({ id: stateObj._id, val: state.status });
            });
        }

        // process limits (Schwellwerte)
        if (statesOf(COMMANDS.LIMIT.name).length) {
            objs.push(createChannel(segment, module, device.name, COMMANDS.LIMIT.name));

            statesOf(COMMANDS.LIMIT.name).forEach(state => {
                count('limits');
                const stateObj = createNumberState(
                    segment,
                    module,
                    device.name,
                    COMMANDS.LIMIT.name,
                    state.input,
                    true,
                    state.limit,
                );
                objs.push(stateObj);
                states.push({ id: stateObj._id, val: state.status });
            });
        }

        // process regulator set value
        if (statesOf(COMMANDS.REGULATOR_OUT.name).length) {
            objs.push(createChannel(segment, module, device.name, COMMANDS.REGULATOR_OUT.name));
            statesOf(COMMANDS.REGULATOR_OUT.name).forEach(state => {
                count('regulator');
                const stateObj = createNumberState(
                    segment,
                    module,
                    device.name,
                    COMMANDS.REGULATOR_OUT.name,
                    state.input,
                    true,
                );
                objs.push(stateObj);
                states.push({ id: stateObj._id, val: state.status });
            });
        }
        if (statesOf(COMMANDS.REGULATOR_LOCK_OUT.name).length) {
            objs.push(createChannel(segment, module, device.name, COMMANDS.REGULATOR_LOCK_OUT.name));
            native.regulator ||= true;
            statesOf(COMMANDS.REGULATOR_LOCK_OUT.name).forEach(state => {
                const stateObj = createNumberState(
                    segment,
                    module,
                    device.name,
                    COMMANDS.REGULATOR_LOCK_OUT.name,
                    state.input,
                    true,
                );
                objs.push(stateObj);
                states.push({ id: stateObj._id, val: state.status });
            });
        }

        // process relays
        if (statesOf(COMMANDS.RELAY_IN.name).length) {
            objs.push(createChannel(segment, module, device.name, COMMANDS.RELAY_IN.name));
            statesOf(COMMANDS.RELAY_IN.name).forEach(state => {
                count('relays');
                const stateObj = createBooleanState(
                    segment,
                    module,
                    device.name,
                    COMMANDS.RELAY_IN.name,
                    state.input,
                    true,
                );

                // if IN and OUT relays are the same, use another command
                if (this.config.combinedRelays) {
                    stateObj.native.command = COMMANDS.RELAY_OUT.name;
                }

                objs.push(stateObj);
                states.push({ id: stateObj._id, val: state.status });
            });
        }

        // If some LED_IN found => register them as LED_OUT
        if (statesOf(COMMANDS.LED_IN.name).length) {
            // process LEDs
            objs.push(createChannel(segment, module, device.name, COMMANDS.LED_OUT.name));
            statesOf(COMMANDS.LED_IN.name).forEach(state => {
                count('leds');
                const stateObj = createBooleanState(
                    segment,
                    module,
                    device.name,
                    COMMANDS.LED_OUT.name,
                    state.input,
                    true,
                );
                objs.push(stateObj);
                states.push({ id: stateObj._id, val: state.status });
            });
        }

        for (let t = 0; t < 4; t++) {
            const C = 'ABCD'[t];
            const _id = `${id}.${COMMANDS.BUTTON.name}S_${C}`;
            // process Buttons
            objs.push({
                _id,
                common: {
                    name: `${device.name} buttons ${C}`,
                },
                type: 'channel',
                native: {
                    segment,
                    module,
                    command: COMMANDS.BUTTON.name,
                },
            });
            for (let a = 1; a <= 8; a++) {
                const _sid = `${_id}.${COMMANDS.BUTTON.name}_${C}${paddingZero(a)}`;
                objs.push({
                    _id: _sid,
                    common: {
                        name: `${device.name} BUTTON ${C} ${a}`,
                        type: 'number',
                        role: 'state',
                        states: { 0: 'release', 1: 'short', 2: 'long' },
                        write: true,
                        read: false,
                    },
                    type: 'state',
                    native: {
                        segment,
                        module,
                        command: COMMANDS.BUTTON.name,
                        output: C + a,
                    },
                });
            }
        }

        if (statesOf(COMMANDS.SENSOR_IN.name).length) {
            // process sensors
            objs.push(createChannel(segment, module, device.name, COMMANDS.SENSOR_IN.name));
            statesOf(COMMANDS.SENSOR_IN.name).forEach(state => {
                count('sensors');
                const stateObj = createBooleanState(
                    segment,
                    module,
                    device.name,
                    COMMANDS.SENSOR_IN.name,
                    state.input,
                    true,
                );
                objs.push(stateObj);
                states.push({ id: stateObj._id, val: state.status });
            });
        }

        // add device object
        if (!obj) {
            const deviceObj: ioBroker.SettableDeviceObject & { _id: string } = {
                _id: id,
                common: {
                    name,
                    desc: device.comment || '',
                    icon: device.hwType ? `/icons/${device.hwType}.png` : undefined,
                },
                type: 'device',
                native: {
                    segment,
                    module,
                    serial: device.serial,
                    fwVersion: device.fwVersion,
                    fwSerial: device.fwSerial,
                    typelessVars: device.typelessVars,
                    hwType: device.hwType,
                    manufacturer: device.manufacturer,
                    name: device.name,
                    ...native,
                },
            };
            objs.push(deviceObj);
        } else {
            if (!obj.common.name) {
                obj.common.name = name;
            }
            if ((!obj.common.icon || obj.common.icon.match(/^\/icons\/[-_\w]+\.png$/)) && device.hwType) {
                obj.common.icon = device.hwType ? `/icons/${device.hwType}.png` : undefined;
            }
            obj.common.desc = device.comment || '';

            obj.native = {
                segment,
                module,
                serial: device.serial,
                fwVersion: device.fwVersion,
                fwSerial: device.fwSerial,
                typelessVars: device.typelessVars,
                hwType: device.hwType,
                manufacturer: device.manufacturer,
                name: device.name,
                relaysOut: obj.native.relaysOut,
                display: !!obj.native.display,
                regulator: !!obj.native.regulator,
                ...native,
            };

            // update object
            this.objects[`${this.namespace}.${id}`] = obj;
            await this.setObjectAsync(id, obj);
        }

        await this.writeObjs(objs);
        await this.writeStates(states);
        for (const variable of variables) {
            if (variable.val !== undefined) {
                await this.updateVariable(`${this.namespace}.${variable.id}`, COMMANDS.VAR.name, variable.val);
            }
        }
        return isNew;
    }

    private async processFoundDevices(found: FoundModules): Promise<ScanResultInfo> {
        const info: ScanResultInfo = { total: Object.keys(found).length, _new: 0 };

        for (const module of Object.keys(found)) {
            const device = found[module];
            if (!device) {
                continue;
            }
            found[module] = null;

            if (await this.createModuleObjects(device)) {
                info._new++;
            }
        }
        return info;
    }

    private resolveName(segment: number, module: number): string {
        const id = `${this.namespace}.${getAddress(segment, module)}`;
        const name = this.objects[id]?.common?.name;
        if (this.objects[id]?.common) {
            return typeof name === 'object' ? name.en || '' : name || '';
        }
        return `S${formatNumber(segment)}.M${formatNumber(module)}`;
    }

    /**
     * Read the states of all known modules
     *
     * @param startDelay delay in ms before the read starts
     * @returns number of modules
     */
    private readAll(startDelay?: number): number {
        const reads: ReadTask[] = [];
        for (const id of Object.keys(this.objects)) {
            const obj = this.objects[id];
            if (obj.type === 'device') {
                if (!reads.find(addr => addr.module === obj.native.module && addr.segment === obj.native.segment)) {
                    reads.push({
                        segment: obj.native.segment,
                        module: obj.native.module,
                        native: obj.native as LcnDeviceNative,
                    });
                }
            }
        }
        if (reads.length) {
            this.statusReadRunning = true;
            this.setTimeout(() => {
                this.log.info(`Status read of ${reads.length} started`);
                if (!this.lcn) {
                    this.statusReadRunning = false;
                    return;
                }
                this.lcn.scanModules(reads, e => {
                    this.statusReadRunning = false;
                    if (e) {
                        this.log.error(e);
                    } else {
                        this.log.info('Status read finished');
                    }
                });
            }, startDelay || 0);
        }
        return reads.length;
    }

    /**
     * Collect the variables of all modules, that must be read cyclically
     *
     * @returns one entry per module with the numbers of its variables
     */
    private getVariableReads(): { segment: number; module: number; inputs: number[]; typeless: boolean }[] {
        const reads: Record<string, { segment: number; module: number; inputs: number[]; typeless: boolean }> = {};
        for (const id of Object.keys(this.objects)) {
            const obj = this.objects[id];
            if (obj.type !== 'state' || obj.native?.command !== COMMANDS.VAR.name) {
                continue;
            }
            const native = obj.native as LcnStateNative;
            const input = parseInt(String(native.output), 10);
            if (!input) {
                continue;
            }
            const deviceId = `${this.namespace}.${getAddress(native.segment, native.module)}`;
            reads[deviceId] ||= {
                segment: native.segment,
                module: native.module,
                inputs: [],
                typeless: !!(this.objects[deviceId]?.native as LcnDeviceNative | undefined)?.typelessVars,
            };
            if (!reads[deviceId].inputs.includes(input)) {
                reads[deviceId].inputs.push(input);
            }
        }
        return Object.values(reads).map(read => ({ ...read, inputs: read.inputs.sort((a, b) => a - b) }));
    }

    /** Schedule the next cyclic read of the variables, if it is enabled */
    private scheduleVariableRead(): void {
        if (!this.config.varPollInterval || this.varPollTimer || !this.lcn) {
            return;
        }
        this.varPollTimer = this.setTimeout(() => {
            this.varPollTimer = undefined;
            this.readVariablesCyclic()
                .catch(e => this.log.warn(`Cannot read the variables: ${e}`))
                .finally(() => this.scheduleVariableRead());
        }, this.config.varPollInterval * 60_000);
    }

    /** Read the variables of all modules, one request after another */
    private async readVariablesCyclic(): Promise<void> {
        if (!this.lcn?.isConnected() || this.scan.step !== SCAN_STEP.INACTIVE || this.statusReadRunning) {
            this.log.debug('Cyclic read of the variables skipped: not connected, scan or status read is running');
            return;
        }
        const reads = this.getVariableReads();
        let count = 0;
        for (const read of reads) {
            if (!this.lcn?.isConnected()) {
                break;
            }
            count += await this.lcn.readVariables(read.segment, read.module, read.inputs, read.typeless);
        }
        this.log.debug(`Cyclic read of the variables: received ${count} values from ${reads.length} modules`);
    }

    private async updateVariable(id: string, type: string, value: ioBroker.StateValue | undefined): Promise<void> {
        let obj: ioBroker.Object | undefined;
        try {
            obj = await this.getCachedObject(id);
        } catch {
            // Create objects on the fly if a device is known.
            try {
                await this.createStateOnTheFly(id, type);
                await this.updateVariable(id, type, value);
            } catch (err) {
                this.log.error(`Cannot read object ${id}: ${err}`);
            }
            return;
        }

        try {
            if (type === COMMANDS.VAR.name && typeof value === 'number' && !isNaN(value)) {
                // The value is raw, the conversion depends on the role of the state
                const input = parseInt(String((obj.native as LcnStateNative | undefined)?.output), 10);
                const converted = convertVariable(value, obj.common.role, input);
                value = converted.value;
                if (converted.unit && !obj.common.unit) {
                    obj.common.unit = converted.unit;
                    await this.setForeignObjectAsync(id, obj);
                }
            }

            if (value !== undefined) {
                await this.setForeignStateAsync(id, value, true);
            }
        } catch (err) {
            this.log.error(`Cannot update ${id}: ${err}`);
        }
    }

    /** Create a state of a known device, that was not detected by the scan */
    private async createStateOnTheFly(id: string, type: string): Promise<void> {
        const parts = id.split('.'); // e.g. lcn.0.S000.M011.VARS.VAR02
        const last = parts.pop()!; // remove VAR02
        let input: number;
        let limit: number | undefined;
        parts.pop(); // remove VARS
        let m = last.match(/(\d+)_(\d+)$/);
        if (m) {
            input = parseInt(m[1], 10);
            limit = parseInt(m[2], 10);
        } else {
            m = last.match(/(\d+)$/);
            if (!m) {
                throw new Error('Unknown type');
            }
            input = parseInt(m[1], 10);
        }

        const deviceID = parts.join('.');
        const deviceObj = await this.getCachedObject(deviceID).catch(() => null);
        if (!deviceObj) {
            throw new Error('Received update for unknown device');
        }
        const objs: NewObject[] = [];
        let deviceChanged = false;

        // Device exists, so create state on the fly
        const device = deviceObj.native as LcnDeviceNative;
        let name = device.name;
        if (!name) {
            const commonName = deviceObj.common.name;
            name = typeof commonName === 'object' ? commonName.en || '' : commonName || '';
            const pos = name.indexOf('(');
            if (pos !== -1) {
                name = name.substring(0, pos).trim();
            }
        }

        if (!this.objects[`${deviceID}.${type}S`]) {
            // create type
            objs.push(createChannel(device.segment, device.module, name, type));
        }
        // Create state
        if (type === COMMANDS.ANALOG_IN.name) {
            objs.push(createAnalogState(device.segment, device.module, name, input));
            // update device
            if (!device.analogs || device.analogs < input) {
                device.analogs = input;
                deviceChanged = true;
            }
        } else if (type === COMMANDS.LIMIT.name) {
            objs.push(createNumberState(device.segment, device.module, name, type, input, true, limit));
            // update device
            if (!device.limits || device.limits < input) {
                device.limits = input;
                deviceChanged = true;
            }
        } else if (type === COMMANDS.VAR.name) {
            objs.push(createNumberState(device.segment, device.module, name, type, input, true));
            // update device
            if (!device.vars || device.vars < input) {
                device.vars = input;
                deviceChanged = true;
            }
        } else if (type === COMMANDS.COUNTER.name) {
            objs.push(createNumberState(device.segment, device.module, name, type, input, true));
            // update device
            if (!device.counters || device.counters < input) {
                device.counters = input;
                deviceChanged = true;
            }
        } else if (type === COMMANDS.SUM.name) {
            objs.push(createNumberState(device.segment, device.module, name, type, input, false));
        } else if (type === COMMANDS.REGULATOR_OUT.name) {
            objs.push(createNumberState(device.segment, device.module, name, type, input, true));
            // update device
            if (!device.regulator) {
                device.regulator = true;
                deviceChanged = true;
            }
        } else if (type === COMMANDS.RELAY_IN.name) {
            objs.push(createBooleanState(device.segment, device.module, name, type, input, true));
            // update device
            if (!device.relays || device.relays < input) {
                device.relays = input;
                deviceChanged = true;
            }
        } else if (type === COMMANDS.LED_IN.name) {
            objs.push(createBooleanState(device.segment, device.module, name, type, input, true));
            // update device
            if (!device.leds || device.leds < input) {
                device.leds = input;
                deviceChanged = true;
            }
        } else if (type === COMMANDS.SENSOR_IN.name) {
            objs.push(createBooleanState(device.segment, device.module, name, type, input, true));
            // update device
            if (!device.sensors || device.sensors < input) {
                device.sensors = input;
                deviceChanged = true;
            }
        }
        if (!objs.length) {
            throw new Error('Unknown type');
        }

        // The created state must have exactly the requested ID,
        // otherwise updateVariable would call itself endlessly (see #119)
        const stateId = `${this.namespace}.${objs[objs.length - 1]._id}`;
        if (stateId !== id) {
            throw new Error(`Generated object ID ${stateId} does not match`);
        }

        if (deviceChanged) {
            await this.setForeignObjectAsync(deviceObj._id, deviceObj); // update device
        }

        await this.writeObjs(objs);
    }

    private onUpdate(data: LcnState): void {
        const ns = this.namespace;
        if (data.type === COMMANDS.IR.name) {
            if (data.serial !== undefined) {
                void this.setState('ir.serial', data.serial, true);
            }
            if (data.level !== undefined) {
                void this.setState('ir.level', data.level, true);
            }
            if (data.key !== undefined) {
                void this.setState('ir.key', data.key, true);
            }
            if (data.lowBat !== undefined) {
                void this.setState('ir.lowbat', data.lowBat, true);
            }
            if (data.action !== undefined) {
                void this.setState('ir.action', data.action, true);
            }
        } else if (data.type === COMMANDS.FINGER_SCAN.name) {
            if (data.serial !== undefined) {
                void this.setState('finger.code', data.serial, true);
            }
        } else if (
            data.type === COMMANDS.ANALOG_IN.name ||
            data.type === COMMANDS.RELAY_IN.name ||
            data.type === COMMANDS.SENSOR_IN.name ||
            data.type === COMMANDS.VAR.name ||
            data.type === COMMANDS.COUNTER.name ||
            data.type === COMMANDS.REGULATOR_OUT.name ||
            data.type === COMMANDS.REGULATOR_LOCK_OUT.name ||
            data.type === COMMANDS.LED_IN.name ||
            data.type === COMMANDS.SUM.name
        ) {
            const id = `${ns}.${getAddress(data.segment, data.module)}.${data.type}S.${data.type}${paddingZero(data.input)}`;
            void this.updateVariable(id, data.type, data.status);
        } else if (data.type === COMMANDS.MEASURE.name) {
            // A value without the number of the variable (module with firmware before 170206), that was not requested.
            // It cannot be assigned to a state. Before 4.0.0 the adapter tried to write `MEASURES.MEASURE`
            // with the value `undefined` and logged an error
            this.log.debug(
                `Ignored value ${data.value} of ${getAddress(data.segment, data.module)} without the number of the variable`,
            );
        } else if (data.type === COMMANDS.LIMIT.name) {
            const id = `${ns}.${getAddress(data.segment, data.module)}.${data.type}S.${data.type}${paddingZero(data.input)}_${paddingZero(data.limit)}`;
            void this.updateVariable(id, data.type, data.status);
        } else {
            this.log.warn(`Unknown update: ${JSON.stringify(data)}`);
        }
    }

    private onScanProgress(newScan: ScanProgress): void {
        if (this.scan.step !== newScan.step) {
            this.scan.step = newScan.step;
            if (this.scan.step !== undefined) {
                void this.setState('scan.step', this.scan.step, true);
            }
        }
        if (this.scan.progress !== newScan.progress) {
            this.scan.progress = newScan.progress;
            if (this.scan.progress !== undefined) {
                void this.setState('scan.progress', this.scan.progress, true);
            }
        }
        if (this.scan.found !== newScan.found) {
            this.scan.found = newScan.found;
            if (this.scan.found !== undefined) {
                void this.setState('scan.found', this.scan.found, true);
            }
        }
        this.scanListener?.(newScan);
    }

    private startLCN(): void {
        let logger: LcnLogger;
        if (process.argv.includes('--logs')) {
            logger = {
                info: text => this.log.info(`${new Date().toISOString()} - ${text}`),
                debug: text => this.log.debug(`${new Date().toISOString()} - ${text}`),
                warn: text => this.log.warn(`${new Date().toISOString()} - ${text}`),
                error: text => this.log.error(`${new Date().toISOString()} - ${text}`),
            };
        } else {
            logger = this.log;
        }
        const lcn = new LCN({
            ...this.config,
            logger,
            resolveName: (segment: number, module: number): string => this.resolveName(segment, module),
        });
        this.lcn = lcn;

        lcn.on('connected', () => {
            this.lcnConnected = true;
            void this.setState('info.connection', true, true);
            if (!this.statusReadDone) {
                this.statusReadDone = true;
                if (this.config.readAtStart) {
                    this.readAll(5000);
                }
            }
            this.scheduleVariableRead();
        });

        lcn.on('disconnected', () => {
            this.lcnConnected = false;
            void this.setState('info.connection', false, true);
        });

        lcn.on('update', (data: LcnState) => this.onUpdate(data));

        lcn.on('scan', (newScan: ScanProgress) => this.onScanProgress(newScan));
    }

    /** Write the state, if its value differs */
    private async resetState(id: string, val: ioBroker.StateValue | undefined): Promise<void> {
        const state = await this.getStateAsync(id);
        if ((!state || state.val !== val) && val !== undefined) {
            await this.setStateAsync(id, val, true);
        }
    }

    private async onReady(): Promise<void> {
        if (this.lcn) {
            return;
        }

        this.log.debug('[main] start');

        // The settings could be stored as strings by older versions of the admin
        const config = this.config as unknown as Record<keyof ioBroker.AdapterConfig, unknown>;
        this.config.host ||= '127.0.0.1';
        this.config.port = parseInt(config.port as string, 10) || 4114;
        this.config.reconnectTimeout = (parseInt(config.reconnectTimeout as string, 10) || 30) * 1000; // in seconds
        this.config.defaultTimeout = parseInt(config.defaultTimeout as string, 10) || 1000;
        this.config.pingInterval = (parseInt(config.pingInterval as string, 10) || 30) * 1000; // in seconds
        this.config.pingTimeout = parseInt(config.pingTimeout as string, 10) || 1000;
        this.config.analogMode = parseInt(config.analogMode as string, 10) || 1;
        this.config.connectTimeout = parseInt(config.connectTimeout as string, 10) || 6000;
        this.config.scanResponseTimeout = parseInt(config.scanResponseTimeout as string, 10) || 1000;
        // in minutes, 0 = off
        this.config.varPollInterval = Math.max(0, parseInt(config.varPollInterval as string, 10) || 0);
        this.config.combinedRelays =
            config.combinedRelays === undefined
                ? true
                : config.combinedRelays === true || config.combinedRelays === 'true';

        // reset states
        await this.resetState('info.connection', false);
        await this.resetState('scan.step', this.scan.step);
        await this.resetState('scan.progress', this.scan.progress);
        await this.resetState('scan.found', this.scan.found);

        await this.subscribeObjectsAsync('*');

        const stateObjects = await this.getStatesOfAsync('', '');
        stateObjects.sort((a, b) => (a._id === b._id ? 0 : a._id > b._id ? 1 : -1));

        for (const obj of stateObjects) {
            if (obj && INVALID_SUM_ID.test(obj._id)) {
                // Remove objects created by the faulty handling of logic operations (see #119)
                this.log.info(`Deleting invalid object ${obj._id}`);
                this.delForeignObject(obj._id, err => err && this.log.warn(`Cannot delete ${obj._id}: ${err}`));
                continue;
            }
            if (obj?.native && obj._id.startsWith(`${this.namespace}.S`)) {
                this.objects[obj._id] = obj;
            }
        }

        const devices = await this.getDevicesAsync();
        devices.forEach(obj => {
            if (obj._id.startsWith(`${this.namespace}.S`)) {
                this.objects[obj._id] = obj;
            }
        });
        await this.subscribeStatesAsync('*');
        await this.recalculateRelays(); // create relays out states if required
        this.startLCN();

        this.deviceManagement = new LcnDeviceManagement(this);
    }

    // ---------- API for the device manager ----------

    public getLcnDevices(): LcnDevice[] {
        const prefix = `${this.namespace}.`;
        return Object.keys(this.objects)
            .filter(id => this.objects[id]?.type === 'device' && this.objects[id].native)
            .map(id => ({
                id: id.substring(prefix.length),
                common: this.objects[id].common as ioBroker.DeviceCommon,
                native: this.objects[id].native as LcnDeviceNative,
            }));
    }

    public isLcnConnected(): boolean {
        return !!this.lcn?.isConnected();
    }

    public async scanRange(
        range: string,
        segment: number,
        onProgress?: (progress: ScanProgress) => void,
    ): Promise<ScanResultInfo> {
        if (!Number.isInteger(segment) || segment < 0 || segment > 255) {
            throw new Error(`Invalid segment ${segment}`);
        }
        const parts = range.split('-');
        let min: number;
        let max: number;
        if (parts.length === 2) {
            min = parseInt(parts[0], 10);
            max = parseInt(parts[1], 10);
        } else {
            min = 3;
            max = parseInt(parts[0], 10);
        }

        this.scanListener = onProgress || null;
        try {
            const found = await this.lcnConnection.scanSegment(min, max, segment);
            const info = await this.processFoundDevices(found);
            this.log.info(`Found total ${info.total} modules in segment ${segment}. New ${info._new}`);
            return info;
        } finally {
            this.scanListener = null;
        }
    }

    public readAllStates(): number {
        return this.readAll();
    }

    public async updateDeviceSettings(id: string, settings: LcnDeviceSettings): Promise<void> {
        const fullId = `${this.namespace}.${id}`;
        const obj = await this.getForeignObjectAsync(fullId);
        if (!obj || obj.type !== 'device') {
            throw new Error(`Device ${id} not found`);
        }
        obj.native.relaysOut = settings.relaysOut;
        obj.native.regulator = settings.regulator;
        obj.native.display = settings.display;
        // objectChange recalculates the relay, display and regulator states
        await this.setForeignObjectAsync(fullId, obj);
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new LcnAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new LcnAdapter())();
}
