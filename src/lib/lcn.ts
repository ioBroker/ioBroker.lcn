/*
 * Copyright (c) 2018-2024 bluefox <dogafox@gmail.com> CC-BY-NC-4.0
 * Copyright (c) 2025-2026 bluefox <dogafox@gmail.com> MIT
 */
import { EventEmitter } from 'node:events';
import { Connection } from './connection';
import { COMMANDS, CMDS, getCommand, type CommandArgument, type CommandDefinition } from './cmds';
import type { FoundModule, FoundModules, LcnLogger, LcnOptions, LcnState, ReadTask } from './types';

// The library uses its own timers, so it can be used without the adapter.

// events
//  - connected
//  - disconnected
//  - update
//  - scan
export const SCAN_STEP = {
    INACTIVE: 0,
    SCANNING: 1,
    READING: 2,
} as const;

interface ScanJob {
    segment: number;
    min: number;
    max: number;
    module: number;
    found: Record<string, FoundModule>;
    resolve: (found: Record<string, FoundModule>) => void;
    reject: (reason: string) => void;
}

export class LCN extends EventEmitter {
    private readonly logger: LcnLogger;
    private readonly segment: number;
    private readonly scanResponseTimeout: number;
    private readonly resolveName: (segment: number, module: number) => string;
    private conn: Connection | null = null;
    private connected = false;
    private scan: ScanJob | null = null;
    private scanTimer: NodeJS.Timeout | null = null;
    private commandKeys: string[] | null = null;

    constructor(options: LcnOptions) {
        super();
        if (!options) {
            throw new Error('No options provided');
        }
        this.logger = options.logger;
        this.segment = options.segment || 0;

        // init parser with valid mode
        CMDS.setAnalogMode(options.analogMode || 1);
        this.resolveName =
            options.resolveName ||
            ((segment: number, module: number): string =>
                `S${CMDS.formatNumber(segment)}.M${CMDS.formatNumber(module)}`);
        this.scanResponseTimeout = options.scanResponseTimeout || 1000;

        this.initConnection(options);
    }

    private get connection(): Connection {
        if (!this.conn) {
            throw new Error('LCN connection is destroyed');
        }
        return this.conn;
    }

    private initConnection(options: LcnOptions): void {
        const conn = new Connection(options);
        this.conn = conn;

        conn.on('connected', () => {
            if (!this.connected) {
                this.connected = true;
                this.emit('connected');
            }
        });

        conn.on('disconnected', () => {
            if (this.connected) {
                this.connected = false;
                this.emit('disconnected');
                if (this.scan) {
                    this.logger.error('[LCN] Scan interrupted, because disconnection');
                    this.scan.resolve(this.scan.found);
                    this.scan = null;
                }
            }
        });

        conn.on('data', (data: string) => {
            this.commandKeys ||= Object.keys(COMMANDS);

            const cmd = this.commandKeys.find(key => getCommand(key)!.detect.test(data));
            if (cmd) {
                const parsed = getCommand(cmd)!.parse(data);
                if (parsed) {
                    parsed.forEach(state => {
                        this.logger.debug(
                            `[LCN][RECEIVED] ${this.resolveName(state.segment, state.module)} - ${JSON.stringify(state)}`,
                        );

                        if (state.success === undefined && !state.error) {
                            const found = this.scan?.found[state.module];
                            if (this.scan && state.segment === this.scan.segment && found) {
                                found.states ||= [];
                                found.states.push(state);
                            } else {
                                this.emit('update', state);
                            }
                        } else {
                            this.logger.warn(`[LCN] Received ack, but no command for it: ${JSON.stringify(state)}`);
                        }
                    });
                } else {
                    this.logger.warn(`[LCN] Cannot parse data: ${data}`);
                }
            } else {
                this.logger.warn(`[LCN] unknown data received: ${data}`);
            }
        });

        conn.on('state', () => {
            // this.logger.debug('new state: ' + Connection.state2text(state));
        });
        conn.on('error', () => {
            // this.logger.debug('new state: ' + Connection.state2text(state));
        });
    }

    isConnected(): boolean {
        return this.connected;
    }

    scanSegment(minScan?: number, maxScan?: number, segment?: number): Promise<FoundModules> {
        minScan ||= 3;
        maxScan ||= 250;
        segment ||= this.segment;

        if (this.scan) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject(`scan for segment ${this.scan.segment} already running`);
        }
        if (!this.connected) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject('LCN not connected');
        }

        return new Promise((resolve, reject) => {
            this.scan = {
                segment: segment,
                min: minScan,
                max: maxScan,
                module: minScan,
                found: {},
                resolve,
                reject,
            };
            void this._processScan();
        });
    }

    private _later(cb: () => void, ms: number): void {
        this.scanTimer = setTimeout(() => {
            this.scanTimer = null;
            cb();
        }, ms);
    }

    private _processNextScan(): void {
        const scan = this.scan;
        if (!scan) {
            return;
        }
        scan.module++;
        if (scan.module > scan.max) {
            scan.module = -1;
            this._later(() => void this._processScanRead(), 100);
        } else {
            this._later(() => void this._processScan(), 100);
        }
    }

    private async _processScan(): Promise<void> {
        const scan = this.scan;
        if (!scan) {
            // scan was interrupted
            return;
        }
        this.logger.debug(`[LCN][SCAN0] Detect ${scan.segment}:${scan.module}...`);
        this.emit('scan', {
            step: SCAN_STEP.SCANNING,
            progress: scan.module,
            found: Object.keys(scan.found).length,
        });

        let data: string | undefined;
        try {
            data = await this.connection.commandPromise(
                COMMANDS.NAME.generate({ segment: scan.segment, module: scan.module }, 'name', 1),
                COMMANDS.NAME.detect,
                this.scanResponseTimeout,
            );
        } catch (err) {
            this.logger.debug(`[LCN][SCAN0] Not detected ${scan.segment}:${scan.module}: ${err}`);
            if (err === 'timeout') {
                this._processNextScan();
            } else {
                this.logger.error(`[LCN][SCAN0] Scan interrupted, because: ${err}`);
                scan.resolve(scan.found);
                this.scan = null;
            }
            return;
        }

        // =M000006.N1Name part1
        const parsed = COMMANDS.NAME.parse(data || '')[0];
        if (parsed) {
            if (parsed.segment !== scan.segment || parsed.module !== scan.module) {
                // very late answer for other request
                this.logger.warn(`[LCN][SCAN0] late answer for scan. Please increase default response timeout!`);
            }
            this.logger.debug(`[LCN][SCAN0] Detected ${parsed.segment}:${parsed.module}!`);
            const found = (scan.found[parsed.module] ||= { name: '', comment: '' });
            found.name = String(parsed.status);
            found.comment ||= '';
        }
        this._processNextScan();
    }

    private _processNextRead(): void {
        const scan = this.scan;
        if (!scan) {
            return;
        }
        const modules = Object.keys(scan.found);
        // get the next address
        scan.module = parseInt(modules.find(m => parseInt(m, 10) > scan.module) as string, 10);

        if (!scan.module) {
            // wait 2 seconds till answers will arrive
            this._later(() => {
                this.emit('scan', { step: SCAN_STEP.INACTIVE, progress: scan.module, found: modules.length });
                this.logger.info(`[LCN] Scan finished. Found ${modules.length} modules`);
                for (const module in scan.found) {
                    if (Object.prototype.hasOwnProperty.call(scan.found, module)) {
                        scan.found[module].segment = parseInt(scan.segment.toString(), 10);
                        scan.found[module].module = parseInt(module, 10);
                    }
                }

                scan.resolve(scan.found);
                if (this.scan === scan) {
                    this.scan = null;
                }
            }, 2000);
        } else {
            this._later(() => void this._processScanRead(), 100);
        }
    }

    /** Throws if the answer is for another module than the one currently read */
    private checkModule(scan: ScanJob, parsed: LcnState, what: string): void {
        if (parsed.module !== scan.module) {
            this.logger.warn(
                `[LCN][SCAN1] received ${what} answer for other module: expected - ${scan.module}, received - ${parsed.module}. Increase response timeout in config. This answer will be ignored`,
            );
            throw new Error('Too slow answers');
        }
    }

    private request(command: CommandDefinition, cmd: string): Promise<string | undefined> {
        return this.connection.commandPromise(cmd, command.detect, this.scanResponseTimeout, true);
    }

    private async _processScanRead(): Promise<void> {
        const scan = this.scan;
        if (!scan) {
            // scan was interrupted
            return;
        }
        if (scan.module === -1) {
            const modules = Object.keys(scan.found);
            if (!modules.length) {
                this.emit('scan', { step: SCAN_STEP.INACTIVE, progress: scan.module, found: 0 });
                this.logger.info('[LCN][SCAN1] Scan stopped. No one module found');
                scan.resolve(scan.found);
                this.scan = null;
                return;
            }
            scan.module = parseInt(modules[0], 10);
        }

        this.emit('scan', {
            step: SCAN_STEP.READING,
            progress: scan.module,
            found: Object.keys(scan.found).length,
        });
        this.logger.debug(`[LCN][SCAN1] Read ${scan.segment}:${scan.module}...`);
        const address = { segment: scan.segment, module: scan.module };

        try {
            let data = await this.request(COMMANDS.NAME, COMMANDS.NAME.generate(address, 'name', 2));
            if (data) {
                const parsed = COMMANDS.NAME.parse(data)[0];
                if (parsed.module !== scan.module) {
                    this.logger.warn(
                        `[LCN][SCAN1] received name answer for other module: expected - ${scan.module}, received - ${parsed.module}. Increase response timeout in config. This answer will be ignored`,
                    );
                    throw new Error('Too slow answers');
                }
                const found = (scan.found[parsed.module] ||= { name: '', comment: '', states: [] });
                found.name += parsed.status || '';
                found.name = found.name.trim();
                this.logger.debug(`[LCN][SCAN1] Name2 ${parsed.segment}:${parsed.module}: ${found.name}`);
            } else {
                this.logger.debug(`[LCN][SCAN1] Name2 timeout`);
            }

            data = await this.request(COMMANDS.NAME, COMMANDS.NAME.generate(address, 'comment', 1));
            if (data) {
                const parsed = COMMANDS.NAME.parse(data)[0];
                this.checkModule(scan, parsed, 'Comment1');
                scan.found[parsed.module].comment = String(parsed.status || '');
                this.logger.debug(
                    `[LCN][SCAN1] Comment1 ${parsed.segment}:${parsed.module}: ${scan.found[parsed.module].comment}`,
                );
            } else {
                this.logger.debug(`[LCN][SCAN1] Comment1 timeout`);
            }

            const module = scan.found[scan.module];

            data = await this.request(COMMANDS.NAME, COMMANDS.NAME.generate(address, 'comment', 2));
            if (data) {
                const parsed = COMMANDS.NAME.parse(data)[0];
                this.checkModule(scan, parsed, 'Comment2');
                module.comment += parsed.status || '';
                this.logger.debug(`[LCN][SCAN1] Comment2 ${scan.segment}:${scan.module}: ${module.comment}`);
            } else {
                this.logger.debug(`[LCN][SCAN1] Comment2 timeout`);
            }

            data = await this.request(COMMANDS.NAME, COMMANDS.NAME.generate(address, 'comment', 3));
            if (data) {
                const parsed = COMMANDS.NAME.parse(data)[0];
                this.checkModule(scan, parsed, 'Comment3');
                module.comment += parsed.status || '';
                module.comment = module.comment.trim();
                this.logger.debug(`[LCN][SCAN1] Comment3 ${scan.segment}:${scan.module}: ${module.comment}`);
            } else {
                this.logger.debug(`[LCN][SCAN1] Comment3 timeout`);
            }

            data = await this.request(COMMANDS.SERIAL, COMMANDS.SERIAL.generate(address));
            if (data) {
                const parsed = COMMANDS.SERIAL.parse(data)[0];
                this.checkModule(scan, parsed, 'Serial');
                module.serial = parsed.serial;
                module.manufacturer = parsed.manufacturer;
                module.hwType = parsed.hwType;
                module.fwVersion = parsed.fwVersion;
                this.logger.debug(`[LCN][SCAN1] Serial ${scan.segment}:${scan.module}: ${JSON.stringify(parsed)}`);
            } else {
                this.logger.debug(`[LCN][SCAN1] Serial timeout`);
            }

            for (let i = 1; i < 12; i++) {
                // answers will be processed in on('data', () =>)
                this.connection.command(
                    COMMANDS.VAR.generate({ ...address, input: i }),
                    COMMANDS.VAR.detect,
                    this.scanResponseTimeout,
                    true,
                );
            }
            data = await this.request(COMMANDS.VAR, COMMANDS.VAR.generate({ ...address, input: 12 }));
            if (data) {
                const parsed = COMMANDS.VAR.parse(data);
                if (!parsed) {
                    throw new Error(`Cannot parse ${data}`);
                }
                this.checkModule(scan, parsed[0], 'VAR');
                module.states ||= [];
                parsed.forEach(item => module.states!.push(item));
                this.logger.debug(`[LCN][SCAN1] VAR state ${scan.segment}:${scan.module}: ${module.states.length}`);
            } else {
                this.logger.debug(`[LCN][SCAN1] VAR timeout`);
            }

            for (let r = 1; r <= 2; r++) {
                data = await this.request(COMMANDS.REGULATOR, COMMANDS.REGULATOR.generate({ ...address, input: r }));
                if (data) {
                    const parsed = COMMANDS.REGULATOR.parse(data);
                    this.checkModule(scan, parsed[0], `REGULATOR${r}`);
                    module.states ||= [];
                    parsed.forEach(item => module.states!.push(item));
                    this.logger.debug(
                        `[LCN][SCAN1] REGULATOR${r} state ${scan.segment}:${scan.module}: ${module.states.length}`,
                    );
                } else {
                    this.logger.debug(`[LCN][SCAN1] REGULATOR${r} timeout`);
                }
            }

            data = await this.request(COMMANDS.LED_IN, COMMANDS.LED_IN.generate(address));
            if (data) {
                const items = COMMANDS.LED_IN.parse(data);
                module.states ||= [];
                items.forEach(item => module.states!.push(item));

                this.logger.debug(`[LCN][SCAN1] LED states ${scan.segment}:${scan.module}: ${module.states.length}`);

                // If LEDS detected, do not scan sensors. Only Relays and Analogs
                data = await this.request(COMMANDS.STATUS_R, COMMANDS.STATUS_R.generate(address));
                if (data) {
                    const statusItems = COMMANDS.STATUS_ALL.parse(data);
                    module.states ||= [];
                    statusItems?.forEach(item => module.states!.push(item));
                    this.logger.debug(`[LCN][SCAN1] Relays ${scan.segment}:${scan.module}: ${module.states.length}`);
                }

                data = await this.request(COMMANDS.STATUS_A, COMMANDS.STATUS_A.generate(address));
            } else {
                this.logger.debug(`[LCN][SCAN1] LED timeout`);
                data = await this.request(COMMANDS.STATUS_ALL, COMMANDS.STATUS_ALL.generate(address));
            }

            if (data) {
                const items = COMMANDS.STATUS_ALL.parse(data);
                module.states ||= [];
                items?.forEach(item => module.states!.push(item));
                this.logger.debug(`[LCN][SCAN1] Status ${scan.segment}:${scan.module}: ${module.states.length}`);
                // make a delay for 1 second, to accept all statuses
                this._later(
                    () => this._processNextRead(),
                    1200 > this.scanResponseTimeout + 200 ? 1200 : this.scanResponseTimeout + 200,
                );
            } else {
                this.logger.debug(`[LCN][SCAN1] Status timeout`);
                this._later(() => this._processNextRead(), 100);
            }
        } catch (e) {
            this.logger.error(`[LCN] Cannot read module ${scan.module}: ${e}`);

            // make a delay for 1 second, to accept all statuses
            this._later(() => this._processNextRead(), 100);
        }
    }

    /** Send one part of a display text and wait for the answer */
    private sendDisplayPart(
        generator: CommandDefinition,
        segment: number,
        module: number,
        output: number,
        part: number,
        text: string,
    ): Promise<string | undefined> {
        return new Promise((resolve, reject) =>
            this.connection.command(
                generator.generate!({ segment, module }, output, part, text),
                generator.detect,
                200,
                true,
                (err, data) => (err ? reject(new Error(err)) : resolve(data)),
            ),
        );
    }

    async control(
        segment: number,
        module: number,
        cmd: string,
        output: number | string | undefined,
        value: CommandArgument,
    ): Promise<string | undefined> {
        const generator = getCommand(cmd) || getCommand(`${cmd}_OUT`);
        if (!generator) {
            throw new Error('Unknown command type');
        }
        if (!generator.generate) {
            throw new Error(`Unable to control ${cmd}`);
        }

        if (cmd === COMMANDS.DISPLAY_OUT.name) {
            if (!value && value !== 0) {
                return this.connection.commandPromise(
                    generator.generate({ segment, module }, output, ''),
                    generator.detect,
                );
            }
            const line = output as number;
            let rest = value.toString();
            let text = rest.substring(0, 12);
            rest = rest.substring(12);
            let prevTextLen = text.length;

            // The text is sent in up to 5 parts of 12 characters
            let data = await this.sendDisplayPart(generator, segment, module, line, 1, text);
            for (let part = 2; part <= 5; part++) {
                text = rest.substring(0, 12);
                rest = rest.substring(12);
                if (!text && prevTextLen !== 12) {
                    break;
                }
                prevTextLen = text.length;
                data = await this.sendDisplayPart(generator, segment, module, line, part, text || '');
            }
            return data;
        }

        return this.connection.commandPromise(generator.generate({ segment, module }, output, value), generator.detect);
    }

    /**
     * Read status
     *
     * @param segment segment address
     * @param module module address
     * @param operation L - LED, S - Sensors, A - Analog, R - Relay, AR - Analog+Relay, ALL - all
     */
    read(segment: number, module: number, operation: string): void {
        const conn = this.connection;
        if (operation === 'L') {
            return conn.command(COMMANDS.LED_IN.generate({ segment, module }));
        }
        if (operation === 'R') {
            return conn.command(COMMANDS.STATUS_R.generate({ segment, module }));
        }
        if (operation === 'RA' || operation === 'AR') {
            conn.command(COMMANDS.STATUS_R.generate({ segment, module }));
            return conn.command(COMMANDS.STATUS_A.generate({ segment, module }));
        }
        if (operation === 'V') {
            for (let input = 1; input <= 12; input++) {
                conn.command(COMMANDS.VAR.generate({ segment, module, input }));
            }
            return;
        }
        if (operation === 'C') {
            for (let input = 1; input <= 4; input++) {
                conn.command(COMMANDS.COUNTER.generate({ segment, module, input }));
            }
            return;
        }
        if (operation === 'SE') {
            for (let input = 1; input <= 3; input++) {
                // Note: SETTING does not exist in COMMANDS, so this throws (sic)
                conn.command(
                    (COMMANDS as Record<string, CommandDefinition>).SETTING.generate!({ segment, module, input }),
                );
            }
            return;
        }
        if (operation === 'A') {
            return conn.command(COMMANDS.STATUS_A.generate({ segment, module }));
        }
        if (operation === 'S') {
            return conn.command(COMMANDS.STATUS_S.generate({ segment, module }));
        }
        conn.command(COMMANDS.STATUS_ALL.generate({ segment, module }));
        conn.command(COMMANDS.STATUS_ALL.generate({ segment, module }));
    }

    scanModules(tasks: ReadTask[], cb?: (error?: string) => void): void {
        if (this.scan) {
            cb?.('[LCN] Read stopped, because scan is active');
        } else if (!tasks?.length) {
            // Before 4.0.0 the condition was `!tasks && !tasks.length`, which is never true
            cb?.();
        } else {
            const task = tasks.shift()!;
            const native = task.native!;
            delete task.native;
            const conn = this.connection;

            if (native.leds) {
                conn.command(COMMANDS.LED_IN.generate(task));
            }
            if (native.relays) {
                conn.command(COMMANDS.STATUS_R.generate(task));
            }
            if (native.analogs) {
                conn.command(COMMANDS.STATUS_A.generate(task));
            }
            if (native.sensors) {
                conn.command(COMMANDS.STATUS_S.generate(task));
            }
            if (native.regulator) {
                for (let i = 1; i <= 2; i++) {
                    task.input = i;
                    conn.command(COMMANDS.REGULATOR.generate(task));
                }
            }

            if (native.vars) {
                for (let i = 1; i <= 12; i++) {
                    task.input = i;
                    conn.command(COMMANDS.VAR.generate(task));
                }
            }
            if (native.counters) {
                for (let i = 1; i <= 4; i++) {
                    task.input = i;
                    conn.command(COMMANDS.COUNTER.generate(task));
                }
            }

            if (tasks.length) {
                this._later(() => this.scanModules(tasks, cb), 1200);
            } else {
                cb?.();
            }
        }
    }

    destroy(cb?: () => void): void {
        if (this.scanTimer) {
            clearTimeout(this.scanTimer);
            this.scanTimer = null;
        }
        if (this.conn) {
            // Before 4.0.0 the callback was passed as `isReconnect`, so the connection was re-opened
            // after the unload and the callback was never called
            this.conn.destroy(false, cb);
            this.conn = null;
        } else {
            cb?.();
        }
    }
}
