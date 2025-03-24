/*
 * Copyright (c) 2018-2024 bluefox <dogafox@gmail.com> CC-BY-NC-4.0
 * Copyright (c) 2025 bluefox <dogafox@gmail.com> MIT
 *
 */

/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */

'use strict';
const adapterName = require('./package.json').name.split('.').pop();
const { Adapter } = require('@iobroker/adapter-core'); // Get common adapter utils

const { LCN, SCAN_STEP } = require('./lib/lcn');
const { COMMANDS } = require('./lib/cmds');
let adapter;

let lcn;
let connected = false;
let objects = {};
let statusReadDone = false;
const scan = { step: SCAN_STEP.INACTIVE, progress: 0, found: 0, l: false };

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: adapterName, // adapter name
    });

    adapter = new Adapter(options);

    // is called when adapter shuts down - callback has to be called under any circumstances!
    adapter.on('unload', callback => {
        try {
            if (connected) {
                adapter.setState('info.connection', false, true);
                connected = false;
            }
            if (lcn) {
                lcn.destroy(callback);
            } else {
                callback && callback();
            }
        } catch {
            callback && callback();
        }
    });

    // is called if a subscribed state changes
    adapter.on('stateChange', (id, state) => {
        // you can use the ack flag to detect if it is status (true) or command (false)
        if (state && !state.ack) {
            if (id.startsWith(adapter.namespace + '.S')) {
                getObject(id).then(obj => {
                    lcn.control(obj.native.segment, obj.native.module, obj.native.command, obj.native.output, state.val)
                        .then(() => adapter.log.debug('Command sent'))
                        .catch(e =>
                            adapter.log.error(
                                `Cannot send ${obj.native.segment}:${obj.native.module}(${obj.native.command}, out=${obj.native.output}, val="${state.val}"): ${e}`,
                            ),
                        );
                });
            } else if (id.match(/scan\.manual$/)) {
                if (!state.val) {
                    adapter.log.debug('Received empty scan command. Ignored.');
                } else if (state.val === '*') {
                    readAll();
                } else {
                    const m = state.val.match(/S?(\d+):(\d+):?(\w)?/i);
                    if (m && m.length > 2) {
                        let segment = parseInt(m[1], 10);
                        let module = parseInt(m[2], 10);
                        let op = (m[3] || 'AR').toUpperCase();
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
                            getObject(id).then(obj => {
                                if (obj.native.leds) {
                                    lcn.read(segment, module, 'AR');
                                } else {
                                    lcn.read(segment, module, op);
                                }
                            });
                        } else {
                            lcn.read(segment, module, op);
                        }
                    } else {
                        adapter.log.warn(
                            `Invalid read command ${state.val}. Expected S0:6S => Segment 0, module 6, read status`,
                        );
                    }
                }
            }
        }
    });

    adapter.on('message', obj => {
        if (obj) {
            switch (obj.command) {
                case 'scanOne':
                case 'scan':
                    {
                        const parts = obj.message.max.split('-');
                        let min;
                        let max;
                        if (parts.length === 2) {
                            min = parseInt(parts[0], 10);
                            max = parseInt(parts[1], 10);
                        } else {
                            min = 3;
                            max = parseInt(parts[0], 10);
                        }

                        lcn.scanSegment(min, max)
                            .then(found => {
                                processFoundDevices(found, info => {
                                    adapter.log.info(`Found total ${info.total} modules. New ${info._new}`);
                                    obj.callback && adapter.sendTo(obj.from, obj.command, info, obj.callback);
                                });
                            })
                            .catch(error => {
                                adapter.log.error(`Cannot scan: ${error}`);
                                obj.callback && adapter.sendTo(obj.from, obj.command, { error }, obj.callback);
                            });
                    }
                    break;

                case 'getAll':
                    const devices = [];
                    for (const id in objects) {
                        if (
                            !objects.hasOwnProperty(id) ||
                            !objects[id] ||
                            !objects[id].native ||
                            objects[id].type !== 'device'
                        ) {
                            continue;
                        }
                        devices.push({ id, native: objects[id].native, common: objects[id].common });
                    }

                    obj.callback && adapter.sendTo(obj.from, obj.command, devices, obj.callback);
                    break;
            }
        }
    });

    adapter.on('objectChange', (id, obj) => {
        if (id && obj) {
            if (objects[id] && id.match(/\.VARS\.VAR\d\d$/)) {
                // if role was defined
                if (obj.common && obj.common.role && objects[id].common && !objects[id].common.role) {
                    // recalculate values
                    setImmediate(() =>
                        adapter.getState(id, (err, state) => {
                            if (state && state.val !== null && state.val !== undefined) {
                                updateVariable(id, COMMANDS.VAR.name, state.val).then(() => {});
                            }
                        }),
                    );
                }
            }
            if (obj.type === 'device') {
                // create relays output
                adapter._recalculateRelays && clearTimeout(adapter._recalculateRelays);
                adapter._recalculateRelays = setTimeout(() => {
                    adapter._recalculateRelays = null;
                    recalculateRelays(adapter);
                }, 1000);
            }
            // store new object
            objects[id] = obj;
        } else if (id) {
            // if object deleted
            if (objects[id]) {
                delete objects[id];
            }
        }
    });

    adapter.on('ready', () => main(adapter));

    return adapter;
}

function processTasks(adapter, tasks, cb) {
    if (!tasks || !tasks.length) {
        cb && cb();
    } else {
        const task = tasks.shift();
        if (task.name === 'create') {
            adapter.log.info(`Create state ${task.id}`);
            adapter.setForeignObject(task.id, task.obj, err => {
                objects[task.id] = task.obj;
                setImmediate(processTasks, adapter, tasks, cb);
            });
        } else if (task.name === 'delete') {
            adapter.log.info(`Delete state ${task.id}`);
            if (objects[task.id]) {
                delete objects[task.id];
            }

            adapter.delForeignObject(task.id, () => setImmediate(processTasks, adapter, tasks, cb));
        }
    }
}

function recalculateRelays(adapter, cb) {
    const ids = Object.keys(objects);

    const tasks = [];

    const RELAY_NAME = adapter.config.combinedRelays ? COMMANDS.RELAY_IN.name : COMMANDS.RELAY_OUT.name;

    ids.forEach(id => {
        if (objects[id].type === 'device' && objects[id].native) {
            const device = objects[id].native;
            // check if some relays must be created od deleted
            // find all RELAYS_OUT for this device
            let channelId = `${id}.${RELAY_NAME}S`; // lcn.0.S000.M010.RELAY_OUTS
            let name = `${channelId}.${RELAY_NAME}0`; // lcn.0.S000.M010.RELAY_OUTS.RELAY_OUT0
            const relays = ids.filter(id => id.includes(name));
            let relaysOut = device.relaysOut || 0;
            if (adapter.config.combinedRelays) {
                relaysOut = device.relays > relaysOut ? device.relays : relaysOut;
            }

            // delete all RELAYS_OUT, because not required
            if (adapter.config.combinedRelays) {
                const channelOutId = `${id}.${COMMANDS.RELAY_OUT.name}S`;
                const nameOut = `${channelOutId}.${COMMANDS.RELAY_OUT.name}0`; // lcn.0.S000.M010.RELAY_OUTS.RELAY_OUT0
                const relaysOutList = ids.filter(id => id.includes(nameOut));
                if (relaysOutList.length) {
                    relaysOutList.sort();
                    relaysOutList.forEach(id => tasks.push({ id, name: 'delete' }));
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
                    if (!relaysOut && objects[channelId]) {
                        tasks.push({ id: channelId, name: 'delete' });
                    }
                } else {
                    if (!objects[channelId]) {
                        tasks.push({
                            id: channelId,
                            name: 'create',
                            obj: {
                                _id: channelId,
                                common: {
                                    name: 'Output relays',
                                },
                                type: 'channel',
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
                                    name: 'Output relay ' + (i + 1),
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
            const display = !!ids.find(id => id.startsWith(name));

            if (display !== displayOut) {
                if (!displayOut) {
                    // display must be deleted
                    tasks.push({ id: channelId, name: 'delete' });
                    for (let i = 1; i <= 4; i++) {
                        tasks.push({ id: name + i, name: 'delete' });
                    }
                } else {
                    // display must be created
                    if (!objects[channelId]) {
                        tasks.push({
                            id: channelId,
                            name: 'create',
                            obj: {
                                _id: channelId,
                                common: {
                                    name: { en: 'Display output', de: 'Display-Ausgang' },
                                },
                                type: 'channel',
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
            const regulatorOut = device.regulator || false;
            channelId = `${id}.${COMMANDS.REGULATOR_OUT.name}S`; // lcn.0.S000.M010.REGULATOR_OUT
            name = `${channelId}.${COMMANDS.REGULATOR_OUT.name}0`; // lcn.0.S000.M010.REGULATOR_OUT.REGULATOR0
            const regulator = !!ids.find(id => id.startsWith(name));

            if (regulator !== regulatorOut) {
                if (!regulatorOut) {
                    // regulators must be deleted
                    tasks.push({ id: channelId, name: 'delete' });
                    for (let i = 1; i <= 2; i++) {
                        tasks.push({ id: name + i, name: 'delete' });
                    }
                } else {
                    // regulators must be created
                    if (!objects[channelId]) {
                        tasks.push({
                            id: channelId,
                            name: 'create',
                            obj: {
                                _id: channelId,
                                common: {
                                    name: { en: 'Regulator output', de: 'Regler-Ausgänge' },
                                },
                                type: 'channel',
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
            const regulatorLock = !!ids.find(id => id.startsWith(name));

            if (regulatorLock !== regulatorOut) {
                if (!regulatorOut) {
                    // regulators must be deleted
                    tasks.push({ id: channelId, name: 'delete' });
                    for (let i = 1; i <= 2; i++) {
                        tasks.push({ id: name + i, name: 'delete' });
                    }
                } else {
                    // regulators must be created
                    if (!objects[channelId]) {
                        tasks.push({
                            id: channelId,
                            name: 'create',
                            obj: {
                                _id: channelId,
                                common: {
                                    name: { en: 'Regulator locks', de: 'Regler-Sperren' },
                                },
                                type: 'channel',
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
        }
    });

    processTasks(adapter, tasks, cb);
}

function getObject(id) {
    return new Promise((resolve, reject) => {
        if (objects[id]) {
            resolve(objects[id]);
        } else {
            adapter.getObject(id, (err, obj) => {
                if (err || !obj) {
                    reject(err || 'Not found');
                } else {
                    objects[id] = obj;
                    resolve(obj);
                }
            });
        }
    });
}

function formatNumber(addr) {
    addr = parseInt(addr, 10);
    if (addr < 10) return `00${addr}`;
    if (addr < 100) return `0${addr}`;
    if (addr > 255) throw new Error(`Invalid address ${addr}`);
    return addr.toString();
}

function getAddress(segment, module) {
    return `S${formatNumber(segment)}.M${formatNumber(module)}`;
}

function paddingZero(num) {
    if (num < 10) {
        return `0${num}`;
    } else {
        return num;
    }
}

function writeObjs(objs, cb) {
    if (!objs || !objs.length) {
        cb && cb();
    } else {
        const obj = objs.shift();
        adapter.getObject(obj._id, (err, oldObj) => {
            if (!oldObj) {
                objects[`${adapter.namespace}.${obj._id}`] = obj;

                adapter.setObject(obj._id, obj, err => setImmediate(() => writeObjs(objs, cb)));
            } else {
                objects[oldObj._id] = oldObj;

                setImmediate(() => writeObjs(objs, cb));
            }
        });
    }
}

function writeStates(states, cb) {
    if (!states || !states.length) {
        cb && cb();
    } else {
        const state = states.shift();

        if (state.val !== undefined) {
            adapter.setState(state.id, state.val, true, () => setImmediate(() => writeStates(states, cb)));
        } else {
            setImmediate(() => writeStates(states, cb));
        }
    }
}

function createChannel(segment, module, deviceName, channelName) {
    let id = getAddress(segment, module);

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

function createAnalogState(segment, module, deviceName, input) {
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
            segment: segment,
            module: module,
            command: COMMANDS.ANALOG_OUT.name,
            output: input,
        },
    };
}

function createNumberState(segment, module, deviceName, channelName, input, write, limit) {
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
            segment: segment,
            module: module,
            command: channelName,
            output: input,
        },
    };
}

function createBooleanState(segment, module, deviceName, channelName, input, write) {
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
            segment: segment,
            module: module,
            command: channelName,
            output: input,
        },
    };
}

function createDevice(device) {
    let isNew = true;
    let id = getAddress(device.segment, device.module);
    return new Promise(resolve => {
        adapter.getObject(id, (err, obj) => {
            isNew = !obj;
            const objs = [];
            const states = [];
            const native = {};

            const comment = device.comment || device.hwType;
            const name = device.name + (comment ? ` (${comment})` : '');

            // process analog out
            if (device.states && device.states.find(state => state.type === COMMANDS.ANALOG_IN.name)) {
                objs.push(createChannel(device.segment, device.module, device.name, COMMANDS.ANALOG_IN.name));

                device.states.forEach(state => {
                    if (state.type !== COMMANDS.ANALOG_IN.name) {
                        return;
                    }
                    native.analogs = native.analogs || 0;
                    native.analogs++;
                    const stateObj = createAnalogState(device.segment, device.module, device.name, state.input);
                    objs.push(stateObj);
                    states.push({ id: stateObj._id, val: state.status });
                });
            }

            // process variables
            if (device.states && device.states.find(state => state.type === COMMANDS.VAR.name)) {
                objs.push(createChannel(device.segment, device.module, device.name, COMMANDS.VAR.name));

                device.states.forEach(state => {
                    if (state.type !== COMMANDS.VAR.name) {
                        return;
                    }
                    native.vars = native.vars || 0;
                    native.vars++;
                    const stateObj = createNumberState(
                        device.segment,
                        device.module,
                        device.name,
                        COMMANDS.VAR.name,
                        state.input,
                        true,
                    );
                    objs.push(stateObj);
                    states.push({ id: stateObj._id, val: state.status });
                });
            }

            // process counters
            if (device.states && device.states.find(state => state.type === COMMANDS.COUNTER.name)) {
                objs.push(createChannel(device.segment, device.module, device.name, COMMANDS.COUNTER.name));

                device.states.forEach(state => {
                    if (state.type !== COMMANDS.COUNTER.name) {
                        return;
                    }
                    native.counters = native.counters || 0;
                    native.counters++;
                    const stateObj = createNumberState(
                        device.segment,
                        device.module,
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
            if (device.states && device.states.find(state => state.type === COMMANDS.LIMIT.name)) {
                objs.push(createChannel(device.segment, device.module, device.name, COMMANDS.LIMIT.name));

                device.states.forEach(state => {
                    if (state.type !== COMMANDS.LIMIT.name) {
                        return;
                    }
                    native.limits = native.limits || 0;
                    native.limits++;
                    const stateObj = createNumberState(
                        device.segment,
                        device.module,
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
            if (device.states && device.states.find(state => state.type === COMMANDS.REGULATOR_OUT.name)) {
                objs.push(createChannel(device.segment, device.module, device.name, COMMANDS.REGULATOR_OUT.name));
                device.states.forEach(state => {
                    if (state.type !== COMMANDS.REGULATOR_OUT.name) {
                        return;
                    }
                    native.regulator = native.regulator || 0;
                    native.regulator++;
                    const stateObj = createNumberState(
                        device.segment,
                        device.module,
                        device.name,
                        COMMANDS.REGULATOR_OUT.name,
                        state.input,
                        true,
                    );
                    objs.push(stateObj);
                    states.push({ id: stateObj._id, val: state.status });
                });
            }
            if (device.states && device.states.find(state => state.type === COMMANDS.REGULATOR_LOCK_OUT.name)) {
                objs.push(createChannel(device.segment, device.module, device.name, COMMANDS.REGULATOR_LOCK_OUT.name));
                native.regulator = native.regulator || true;
                device.states.forEach(state => {
                    if (state.type !== COMMANDS.REGULATOR_LOCK_OUT.name) {
                        return;
                    }
                    const stateObj = createNumberState(
                        device.segment,
                        device.module,
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
            if (device.states && device.states.find(state => state.type === COMMANDS.RELAY_IN.name)) {
                objs.push(createChannel(device.segment, device.module, device.name, COMMANDS.RELAY_IN.name));
                device.states.forEach(state => {
                    if (state.type !== COMMANDS.RELAY_IN.name) {
                        return;
                    }
                    native.relays = native.relays || 0;
                    native.relays++;
                    const stateObj = createBooleanState(
                        device.segment,
                        device.module,
                        device.name,
                        COMMANDS.RELAY_IN.name,
                        state.input,
                        true,
                    );

                    // if IN and OUT relays are the same, use another command
                    if (adapter.config.combinedRelays) {
                        stateObj.native.command = COMMANDS.RELAY_OUT.name;
                    }

                    objs.push(stateObj);
                    states.push({ id: stateObj._id, val: state.status });
                });
            }

            // If some LED_IN found => register them as LED_OUT
            if (device.states && device.states.find(state => state.type === COMMANDS.LED_IN.name)) {
                // process LEDs
                objs.push(createChannel(device.segment, device.module, device.name, COMMANDS.LED_OUT.name));
                device.states.forEach(state => {
                    if (state.type !== COMMANDS.LED_IN.name) {
                        return;
                    }
                    native.leds = native.leds || 0;
                    native.leds++;
                    const stateObj = createBooleanState(
                        device.segment,
                        device.module,
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
                        segment: device.segment,
                        module: device.module,
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
                            segment: device.segment,
                            module: device.module,
                            command: COMMANDS.BUTTON.name,
                            output: C + a,
                        },
                    });
                }
            }

            if (device.states && device.states.find(state => state.type === COMMANDS.SENSOR_IN.name)) {
                //const _id = `${id}.${COMMANDS.SENSOR_IN.name}S`;
                // process sensors
                objs.push(createChannel(device.segment, device.module, device.name, COMMANDS.SENSOR_IN.name));
                device.states.forEach(state => {
                    if (state.type !== COMMANDS.SENSOR_IN.name) {
                        return;
                    }
                    native.sensors = native.sensors || 0;
                    native.sensors++;
                    const stateObj = createBooleanState(
                        device.segment,
                        device.module,
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
                obj = {
                    _id: id,
                    common: {
                        name,
                        desc: device.comment || '',
                        icon: device.hwType ? `/icons/${device.hwType}.png` : undefined,
                    },
                    type: 'device',
                    native: {
                        segment: device.segment,
                        module: device.module,
                        serial: device.serial,
                        fwVersion: device.fwVersion,
                        hwType: device.hwType,
                        manufacturer: device.manufacturer,
                        name: device.name,
                    },
                };
                Object.keys(native).forEach(attr => (obj.native[attr] = native[attr]));
                objs.push(obj);
            } else {
                if (!obj.common.name) {
                    obj.common.name = name;
                }
                if ((!obj.common.icon || obj.common.icon.match(/^\/icons\/[-_\w]+\.png$/)) && device.hwType) {
                    obj.common.icon = device.hwType ? `/icons/${device.hwType}.png` : undefined;
                }
                obj.common.desc = device.comment || '';

                obj.native = {
                    segment: device.segment,
                    module: device.module,
                    serial: device.serial,
                    fwVersion: device.fwVersion,
                    hwType: device.hwType,
                    manufacturer: device.manufacturer,
                    name: device.name,
                    relaysOut: obj.native.relaysOut,
                    display: !!obj.native.display,
                    regulator: !!obj.native.regulator,
                };

                Object.keys(native).forEach(attr => (obj.native[attr] = native[attr]));

                // update object
                objects[`${adapter.namespace}.${id}`] = obj;
                adapter.setObject(id, obj);
            }

            writeObjs(objs, () => writeStates(states, () => resolve(isNew)));
        });
    });
}

function processFoundDevices(found, cb, info) {
    info = info || { total: Object.keys(found).length, _new: 0 };

    for (const module in found) {
        if (!found.hasOwnProperty(module) || !found[module]) {
            continue;
        }

        const device = found[module];
        found[module] = null;

        return createDevice(device).then(isNew => {
            isNew && info._new++;
            setImmediate(() => processFoundDevices(found, cb, info));
        });
    }
    cb && cb(info);
}

function resolveName(segment, module) {
    let id = `${adapter.namespace}.${getAddress(segment, module)}`;
    if (objects[id] && objects[id].common) {
        return objects[id].common.name || '';
    } else {
        return `S${formatNumber(segment)}.M${formatNumber(module)}`;
    }
}

function readAll(startDelay) {
    startDelay = startDelay || 0;
    const reads = [];
    for (let id in objects) {
        if (objects.hasOwnProperty(id) && objects[id].type === 'device') {
            if (
                !reads.find(
                    addr => addr.module === objects[id].native.module && addr.segment === objects[id].native.segment,
                )
            ) {
                reads.push({
                    segment: objects[id].native.segment,
                    module: objects[id].native.module,
                    native: objects[id].native,
                });
            }
        }
    }
    if (reads.length) {
        setTimeout(() => {
            adapter.log.info(`Status read of ${reads.length} started`);
            lcn.scanModules(reads, e => (e ? adapter.log.error(e) : adapter.log.info('Status read finished')));
        }, startDelay);
    }
}

function updateVariable(id, type, value) {
    return getObject(id)
        .then(obj => {
            if (!obj) {
                throw new Error(`Received update for non-existing object: ${id}`);
            } else {
                if (type === COMMANDS.VAR.name && obj.common.role) {
                    if (obj.common.role.match(/^value\.temperature/)) {
                        value = (value - 1000) / 10;
                        if (!obj.common.unit) {
                            obj.common.unit = '°C';
                            adapter.setObject(id, obj);
                        }
                    } else if (obj.common.role.match(/^value\.brightness/)) {
                        // value = Math.round(Math.exp(1.689646994 + 0.010380664 * value) * 10) / 10;
                        value = Math.round(Math.exp(value / 100) * 10) / 10;
                        if (!obj.common.unit) {
                            obj.common.unit = 'lux';
                            adapter.setObject(id, obj);
                        }
                    } else if (obj.common.role.match(/^value\.speed\.wind/)) {
                        value = value / 10;
                        if (!obj.common.unit) {
                            obj.common.unit = 'm/s';
                            adapter.setObject(id, obj);
                        }
                    } else if (obj.common.role.match(/^value\.voltage/)) {
                        value = value / 400;
                        if (!obj.common.unit) {
                            obj.common.unit = 'V';
                            adapter.setObject(id, obj);
                        }
                    } else if (obj.common.role.match(/^value\.current/)) {
                        value = value / 10 - 100;
                        if (!obj.common.unit) {
                            obj.common.unit = 'A';
                            adapter.setObject(id, obj);
                        }
                    } else if (
                        obj.common.role.match(/^value\.sun\.azimuth/) ||
                        obj.common.role.match(/^value\.sun\.elevation/)
                    ) {
                        value = value / 10 - 100;
                        if (!obj.common.unit) {
                            obj.common.unit = '°';
                            adapter.setObject(id, obj);
                        }
                    }
                }

                if (value !== undefined) {
                    adapter.setState(id, value, true);
                }
            }
        })
        .catch(err => {
            // Create objects on the fly if a device is known.
            const parts = id.split('.'); // e.g. lcn.0.S000.M011.VARS.VAR02
            let input = parts.pop(); // remove VAR02
            let limit;
            parts.pop(); // remove VARS
            let m = input.match(/(\d+)_(\d+)$/);
            if (m) {
                input = parseInt(m[1], 10);
                limit = parseInt(m[2], 10);
            } else {
                m = input.match(/(\d+)$/);
                if (m) {
                    input = parseInt(m[1], 10);
                }
            }

            const deviceID = parts.join('.');
            return getObject(deviceID)
                .then(deviceObj => {
                    if (deviceObj) {
                        const objs = [];
                        let deviceChanged = false;

                        // Device exists, so create state on the fly
                        const device = deviceObj.native;
                        let name = device.name;
                        if (!name) {
                            name = deviceObj.common.name;
                            const pos = name.indexOf('(');
                            if (pos !== -1) {
                                name = name.substring(0, pos).trim();
                            }
                        }

                        if (!objects[`${deviceID}.${type}`]) {
                            // create type
                            objs.push(createChannel(device.segment, device.module, name, type));
                        }
                        // Create state
                        if (type === COMMANDS.ANALOG_IN.name) {
                            const stateObj = createAnalogState(device.segment, device.module, name, input);
                            // update device
                            if (!device.analogs || device.analogs < input) {
                                device.analogs = input;
                                deviceChanged = true;
                            }
                            objs.push(stateObj);
                        } else if (type === COMMANDS.LIMIT.name) {
                            const stateObj = createNumberState(
                                device.segment,
                                device.module,
                                name,
                                type,
                                input,
                                true,
                                limit,
                            );
                            // update device
                            if (!device.limits || device.limits < input) {
                                device.limits = input;
                                deviceChanged = true;
                            }
                            objs.push(stateObj);
                        } else if (type === COMMANDS.VAR.name) {
                            const stateObj = createNumberState(device.segment, device.module, name, type, input, true);
                            // update device
                            if (!device.vars || device.vars < input) {
                                device.vars = input;
                                deviceChanged = true;
                            }
                            objs.push(stateObj);
                        } else if (type === COMMANDS.COUNTER.name) {
                            const stateObj = createNumberState(device.segment, device.module, name, type, input, true);
                            // update device
                            if (!device.counters || device.counters < input) {
                                device.counters = input;
                                deviceChanged = true;
                            }
                            objs.push(stateObj);
                        } else if (type === COMMANDS.SUM.name) {
                            const stateObj = createNumberState(device.segment, device.module, name, type, input, false);
                            objs.push(stateObj);
                        } else if (type === COMMANDS.REGULATOR_OUT.name) {
                            const stateObj = createNumberState(device.segment, device.module, name, type, input, true);
                            // update device
                            if (!device.regulator) {
                                device.regulator = true;
                                deviceChanged = true;
                            }
                            objs.push(stateObj);
                        } else if (type === COMMANDS.RELAY_IN.name) {
                            const stateObj = createBooleanState(device.segment, device.module, name, type, input, true);
                            // update device
                            if (!device.relays || device.relays < input) {
                                device.relays = input;
                                deviceChanged = true;
                            }
                            objs.push(stateObj);
                        } else if (type === COMMANDS.LED_IN.name) {
                            const stateObj = createBooleanState(device.segment, device.module, name, type, input, true);
                            // update device
                            if (!device.leds || device.leds < input) {
                                device.leds = input;
                                deviceChanged = true;
                            }
                            objs.push(stateObj);
                        } else if (type === COMMANDS.SENSOR_IN.name) {
                            const stateObj = createBooleanState(device.segment, device.module, name, type, input, true);
                            // update device
                            if (!device.sensors || device.sensors < input) {
                                device.sensors = input;
                                deviceChanged = true;
                            }
                            objs.push(stateObj);
                        }
                        if (objs.length) {
                            deviceChanged && adapter.setForeignObject(deviceObj._id, deviceObj); // update device

                            writeObjs(objs, () => updateVariable(id, type, value).then(() => console.log('added')));
                        } else {
                            throw new Error('Unknown type');
                        }
                    } else {
                        throw new Error('Received update for unknown device');
                    }
                })
                .catch(err => adapter.log.error(`Cannot read object ${id}: ${err}`));
        });
}

function startLCN(adapter) {
    if (process.argv.indexOf('--logs') !== -1) {
        adapter.config.logger = {
            info: text => adapter.log.info(`${new Date().toISOString()} - ${text}`),
            debug: text => adapter.log.debug(`${new Date().toISOString()} - ${text}`),
            warn: text => adapter.log.warn(`${new Date().toISOString()} - ${text}`),
            error: text => adapter.log.error(`${new Date().toISOString()} - ${text}`),
        };
    } else {
        adapter.config.logger = adapter.log;
    }
    adapter.config.resolveName = resolveName;
    lcn = new LCN(adapter.config);
    lcn.on('connected', () => {
        adapter.setState('info.connection', true, true);
        if (!statusReadDone) {
            statusReadDone = true;
            if (adapter.config.readAtStart) {
                readAll(5000);
            }
        }
    });

    lcn.on('disconnected', () => adapter.setState('info.connection', false, true));

    lcn.on('update', data => {
        if (data.type === COMMANDS.IR.name) {
            data.serial !== undefined && adapter.setState('ir.serial', data.serial, true);
            data.level !== undefined && adapter.setState('ir.level', data.level, true);
            data.key !== undefined && adapter.setState('ir.key', data.key, true);
            data.lowbat !== undefined && adapter.setState('ir.lowbat', data.lowbat, true);
            data.action !== undefined && adapter.setState('ir.action', data.action, true);
        } else if (data.type === COMMANDS.FINGER_SCAN.name) {
            data.serial !== undefined && adapter.setState('finger.code', data.serial, true);
        } else if (
            data.type === COMMANDS.ANALOG_IN.name ||
            data.type === COMMANDS.RELAY_IN.name ||
            data.type === COMMANDS.SENSOR_IN.name ||
            data.type === COMMANDS.VAR.name ||
            data.type === COMMANDS.COUNTER.name ||
            data.type === COMMANDS.REGULATOR_OUT.name ||
            data.type === COMMANDS.REGULATOR_LOCK_OUT.name ||
            data.type === COMMANDS.LED_IN.name
        ) {
            const id = `${adapter.namespace}.${getAddress(data.segment, data.module)}.${data.type}S.${data.type}${paddingZero(data.input)}`;

            updateVariable(id, data.type, data.status).then(() => {});
        } else if (data.type === COMMANDS.MEASURE.name) {
            const id = `${adapter.namespace}.${getAddress(data.segment, data.module)}.${data.type}S.${data.type}`;

            updateVariable(id, data.type, data.status).then(() => {});
        } else if (data.type === COMMANDS.LIMIT.name) {
            const id = `${adapter.namespace}.${getAddress(data.segment, data.module)}.${data.type}S.${data.type}${paddingZero(data.input)}_${paddingZero(data.limit)}`;

            updateVariable(id, data.type, data.status).then(() => {});
        } else if (data.type === COMMANDS.SUM.name) {
            const id = `${adapter.namespace}.${getAddress(data.segment, data.module)}.${data.type}S.${data.type}${paddingZero(data.input)}_${paddingZero(data.limit)}`;

            updateVariable(id, data.type, data.status).then(() => {});
        } else {
            adapter.log.warn(`Unknown update: ${JSON.stringify(data)}`);
        }
    });

    lcn.on('scan', newScan => {
        if (scan.step !== newScan.step) {
            scan.step = newScan.step;
            scan.step !== undefined && adapter.setState('scan.step', scan.step, true);
        }
        if (scan.progress !== newScan.progress) {
            scan.progress = newScan.progress;
            scan.progress !== undefined && adapter.setState('scan.progress', scan.progress, true);
        }
        if (scan.found !== newScan.found) {
            scan.found = newScan.found;
            scan.found !== undefined && adapter.setState('scan.found', scan.found, true);
        }
    });
}

function main(adapter) {
    if (lcn) {
        return;
    }

    adapter.log.debug('[main] start');

    adapter.config.host = adapter.config.host || '127.0.0.1';
    adapter.config.port = parseInt(adapter.config.port, 10) || 4114;
    adapter.config.reconnectTimeout = (parseInt(adapter.config.reconnectTimeout, 10) || 30) * 1000; // in seconds
    adapter.config.defaultTimeout = parseInt(adapter.config.defaultTimeout, 10) || 1000;
    adapter.config.pingInterval = (parseInt(adapter.config.pingInterval, 10) || 30) * 1000; // in seconds
    adapter.config.pingTimeout = parseInt(adapter.config.pingTimeout, 10) || 1000;
    adapter.config.analogMode = parseInt(adapter.config.analogMode, 10) || 1;
    adapter.config.connectTimeout = parseInt(adapter.config.connectTimeout, 10) || 6000;
    adapter.config.scanResponseTimeout = parseInt(adapter.config.scanResponseTimeout, 10) || 1000;
    adapter.config.combinedRelays =
        adapter.config.combinedRelays === undefined
            ? true
            : adapter.config.combinedRelays === true || adapter.config.combinedRelays === 'true';

    // reset states
    adapter.getState(
        'info.connection',
        (err, state) => (!state || state.val !== false) && adapter.setState('info.connection', false, true),
    );

    adapter.getState(
        'scan.step',
        (err, state) =>
            (!state || state.val !== scan.step) &&
            scan.step !== undefined &&
            adapter.setState('scan.step', scan.step, true),
    );

    adapter.getState(
        'scan.progress',
        (err, state) =>
            (!state || state.val !== scan.progress) &&
            scan.progress !== undefined &&
            adapter.setState('scan.progress', scan.progress, true),
    );

    adapter.getState(
        'scan.found',
        (err, state) =>
            (!state || state.val !== scan.found) &&
            scan.found !== undefined &&
            adapter.setState('scan.found', scan.found, true),
    );

    adapter.subscribeObjects('*');

    adapter.getStatesOf('', '', (err, _objects) => {
        let modules = [];
        _objects.sort((a, b) => {
            if (a._id === b._id) {
                return 0;
            }
            if (a._id > b._id) {
                return 1;
            }
            return -1;
        });

        for (let i = 0; i < _objects.length; i++) {
            const obj = _objects[i];
            if (obj && obj.native && obj._id.startsWith(`${adapter.namespace}.S`)) {
                const addr = getAddress(obj.native.segment, obj.native.module);
                if (!modules.includes(addr)) {
                    modules.push(addr);
                }
                objects[obj._id] = obj;
            }
        }
        modules = [];
        adapter.getDevices((err, _objects) => {
            _objects.forEach(obj => {
                if (obj._id.startsWith(`${adapter.namespace}.S`)) {
                    const addr = getAddress(obj.native.segment, obj.native.module);
                    if (!modules.includes(addr)) {
                        modules.push(addr);
                    }

                    objects[obj._id] = obj;
                }
            });
            adapter.subscribeStates('*');
            recalculateRelays(adapter); // create relays out states if required
            startLCN(adapter);
        });
    });
}

// If started as allInOne mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
