/*
 * Copyright (c) 2018-2024 bluefox <dogafox@gmail.com> CC-BY-NC-4.0
 * Copyright (c) 2025-2026 bluefox <dogafox@gmail.com> MIT
 */
import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { ANALOG_MODES } from './analogModes';
import type { ConnectionOptions, LcnLogger } from './types';

// The library uses its own timers, so it can be used without the adapter.
// All of them are stopped in destroy().

const defaultLogger: LcnLogger = {
    info: (data: string): void => console.log(data),
    debug: (data: string): void => console.log(data),
    warn: (data: string): void => console.warn(data),
    error: (data: string): void => console.error(data),
};

export const STATES = {
    CONNECTING: 0,
    WAIT_PROMPT: 1, // LCN-PCK/IP 1.0
    WAIT_USER: 2, // Username:
    WAIT_PASS: 3, // Password:
    WAIT_AUTH_OK: 4, // OK / Authentication failed.
    WAIT_CONNECTED: 5, // $io:#LCN:connected
    READY: 6,
    WAIT_RESPONSE: 7, // wait response for command
    DISCONNECT: 8, // Disconnecting
} as const;

export type ConnectionState = (typeof STATES)[keyof typeof STATES];

const PROMPT_VERSION = /LCN-PCK\//;
const PROMPT_USERNAME = /^Username:$/;
const PROMPT_PASSWORD = /^Password:$/;
const PROMPT_AUTH_OK = /^OK$/;
const PROMPT_AUTH_FAILED = /^Authentification failed.$/;
const PROMPT_CONNECTED = /^\$io:#LCN:connected$/;
const PROMPT_DISCONNECTED = /^\$io:#LCN:disconnected$/;
const PROMPT_ERROR = /^\(c-error\)$/;
const PROMPT_ERROR_PARAM = /^\((\w\w):p-error\)$/;
const PROMPT_ERROR_LICENSE = /^\$err:\(license\?\)$/;
const PROMPT_MEASURE_UPDATE = /^[%:]M\d\d\d\d\d\d/;

interface ConnectionCommand {
    cmd: string;
    regAnswer: RegExp;
}

const COMMANDS: Record<string, ConnectionCommand> = {
    SET_OUTPUT_MODE_0_50_PERCENT: { cmd: '!OM0P', regAnswer: /^\(0\.\.50-mode percent\)$/ },
    SET_OUTPUT_MODE_0_50_NATIVE: { cmd: '!OM0N', regAnswer: /^\(0\.\.50-mode native\)$/ },
    SET_OUTPUT_MODE_0_200_PERCENT: { cmd: '!OM1P', regAnswer: /^\(0\.\.200-mode percent\)$/ },
    SET_OUTPUT_MODE_0_200_NATIVE: { cmd: '!OM1N', regAnswer: /^\(0\.\.200-mode native\)$/ },
    SET_DECIMAL_MODE: { cmd: '!CHD', regAnswer: /^\(dec-mode\)$/ },
    PING: { cmd: '^ping', regAnswer: /^\^ping(\d+)-?/ }, // ^ping1<LF>
};

/** Called with an error text or with the received answer */
export type CommandCallback = (err: string | null, data?: string) => void;

interface CommandTask {
    cmd: string;
    regAnswer?: RegExp;
    ts: number;
    cb?: CommandCallback;
    timeout?: number;
    ignoreTimeoutError?: boolean;
    timer?: NodeJS.Timeout | null;
}

interface ConnectionParams {
    port: number;
    host: string;
    user: string;
    password: string;
    reconnectTimeout: number;
    defaultTimeout: number;
    pingInterval: number;
    pingTimeout: number;
    analogMode: number;
    connectTimeout: number;
}

function formatNumber(addr: number | string): string {
    const num = parseInt(addr.toString(), 10);
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

// events
// - connected
// - disconnected
// - state
// - error
// - data
// - end
// - close

// Enable decimal mode
// !OM0P // Output-Mode 0..50 percent
// Ask FW version
// ping every 0 seconds

// (c-error)<LF>
// (XXXX:p-error)
// $err:(license?)<LF>

// SN  => =Mssaa.SNnnttFWffHWhh
// >Gssaa.SK
// NMt
// SN

export class Connection extends EventEmitter {
    private readonly params: ConnectionParams;
    private readonly logger: LcnLogger;
    private readonly debug: boolean;
    public readonly resolveName: (segment: number, module: number) => string;

    private connectTimeout: NodeJS.Timeout | null = null;
    private stateTimeout: NodeJS.Timeout | null = null;
    private pingTimeout: NodeJS.Timeout | null = null;
    private pingIndex = 0;
    private requests: CommandTask[] = [];
    private processingCommand: CommandTask | null = null;
    /** null after the socket was closed (see the handlers in connect()) */
    private buffer: string | null = '';
    private shutdown = false;
    private state: ConnectionState = STATES.CONNECTING;
    private socket: Socket | null = null;
    private ready = false;

    static state2text(state: number): string {
        return (
            Object.keys(STATES).find(s => STATES[s as keyof typeof STATES] === state) || `UNKNOWN(${state.toString()})`
        );
    }

    constructor(options: ConnectionOptions) {
        super();

        this.params = {
            port: options.port || 4114,
            host: options.host || '127.0.0.1',
            user: options.user || '',
            password: options.password || '',
            reconnectTimeout: options.reconnectTimeout || 10000,
            defaultTimeout: options.defaultTimeout || 1000,
            pingInterval: options.pingInterval || 300000,
            pingTimeout: options.pingTimeout || options.defaultTimeout || 1000,
            analogMode: options.analogMode || 1,
            connectTimeout: options.connectTimeout || 6000,
        };

        this.resolveName =
            options.resolveName ||
            ((segment: number, module: number): string => `S${formatNumber(segment)}.M${formatNumber(module)}`);
        this.debug = !!options.debug;

        if (this.params.pingInterval < this.params.pingTimeout * 2) {
            this.params.pingInterval = this.params.pingTimeout * 10;
        }

        this.logger = options.logger || defaultLogger;
        this.connect();
    }

    connect(): void {
        this.ready = false;

        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }

        const socket = createConnection(this.params, () => {
            // on Connect
            this._changeState(STATES.WAIT_PROMPT, this.params.connectTimeout);
            this.pingTimeout ||= setTimeout(() => this._sendPing(), this.params.pingInterval);
        });
        this.socket = socket;

        socket.on('error', (error: Error): void => {
            this.buffer = null;
            if (this.socket) {
                this.emit('error', error);
                this.socket.destroy();
                this.socket = null;
            }
        });

        socket.on('end', (): void => {
            this.buffer = null;
            if (this.socket) {
                this.socket.destroy();
                this.socket = null;
                this.emit('end');
            }
            if (!this.shutdown) {
                this.destroy(true);
            }
        });

        socket.on('close', (): void => {
            this.buffer = null;
            if (this.socket) {
                this.socket.destroy();
                this.socket = null;
                this.emit('close');
            }
            if (!this.shutdown) {
                this.destroy(true);
            }
        });

        socket.on('data', (data: Buffer | null): void => {
            if (this.shutdown) {
                return;
            }
            if (!data) {
                this.logger.warn('[CONN] Received null data');
                return;
            }

            // Note: after an error the buffer is null and "null" is prepended to the first line (sic)
            this.buffer = `${this.buffer}${data.toString()}`;
            const lines = this.buffer.split(/\r\n|\n\r|\n|\r/); // any combinations of
            this.buffer = lines[lines.length - 1] || ''; // save the last not full command

            for (let line = 0; line < lines.length - 1; line++) {
                if (lines[line]) {
                    this._processLine(lines[line]);
                }
            }
        });
    }

    private _onError(err: string, reconnect?: boolean): void {
        this.emit('error', err);
        this.logger.error(`[CONN] ${err}. Reconnecting...`);

        if (reconnect && !this.shutdown) {
            this.destroy(true);
        }
    }

    private _changeState(newState: ConnectionState, timeout?: number): void {
        if (newState !== this.state) {
            if (newState === STATES.CONNECTING && this.state !== STATES.CONNECTING) {
                this.emit('disconnected');
            }

            this.logger.debug(
                `[CONN] Changing state: ${Connection.state2text(this.state)} => ${Connection.state2text(newState)}`,
            );
            this.state = newState;
            this.emit('state', this.state);

            if (this.stateTimeout) {
                clearTimeout(this.stateTimeout);
                this.stateTimeout = null;
            }
            if (timeout) {
                this.stateTimeout = setTimeout(
                    () => this._onError(`${Connection.state2text(this.state)} timeout of ${timeout}ms`, true),
                    timeout,
                );
            }
        }

        if (newState === STATES.READY) {
            // process next command
            setImmediate(() => this._processCommands());
        }
    }

    private _resetPingTimer(): void {
        if (this.pingTimeout) {
            clearTimeout(this.pingTimeout);
            this.pingTimeout = setTimeout(() => this._sendPing(), this.params.pingInterval);
        }
    }

    private _sendPing(): void {
        this.pingIndex++;
        this.pingIndex = this.pingIndex % 100;
        this.pingTimeout = null;
        this.commandPromise(
            COMMANDS.PING.cmd + this.pingIndex.toString(),
            COMMANDS.PING.regAnswer,
            this.params.pingTimeout,
        )
            .then(data => {
                const m = data?.match(COMMANDS.PING.regAnswer);
                if (!m || parseInt(m[1], 10) !== this.pingIndex) {
                    this._onError(`Ping mismatch expected ${this.pingIndex}, received ${data}`, true);
                } else {
                    this.pingTimeout = setTimeout(() => this._sendPing(), this.params.pingInterval);
                }
            })
            .catch(() => this._onError('Ping timeout', true));
    }

    private _processLine(data: string): void {
        if (this.debug) {
            this.logger.debug(`[CONN] received: ${data}`);
        }

        switch (this.state) {
            case STATES.CONNECTING:
                this._onError('Received data while connecting');
                break;

            case STATES.WAIT_PROMPT:
                if (PROMPT_VERSION.test(data)) {
                    this._changeState(STATES.WAIT_USER, this.params.connectTimeout);
                } else {
                    this._onError(`Invalid data ${data} while waiting for VERSION`, true);
                }
                break;

            case STATES.WAIT_USER:
                if (PROMPT_USERNAME.test(data)) {
                    this._changeState(STATES.WAIT_PASS, this.params.connectTimeout);

                    // send username
                    this._send(this.params.user).catch(e => this._onError(e, true));
                } else {
                    this._onError(`Invalid data ${data} while waiting for ${PROMPT_USERNAME.toString()}`, true);
                }
                break;

            case STATES.WAIT_PASS:
                if (PROMPT_PASSWORD.test(data)) {
                    this._changeState(STATES.WAIT_AUTH_OK, this.params.connectTimeout);

                    // send password
                    this._send(this.params.password).catch(e => this._onError(e, true));
                } else {
                    this._onError(`Invalid data ${data} while waiting for ${PROMPT_USERNAME.toString()}`, true);
                }
                break;

            case STATES.WAIT_AUTH_OK:
                if (PROMPT_AUTH_OK.test(data)) {
                    this._changeState(STATES.WAIT_CONNECTED, this.params.connectTimeout);
                } else if ((data as unknown) === PROMPT_AUTH_FAILED) {
                    // Note: a string is compared with a RegExp here, so this branch is never taken (sic)
                    this._onError(`Authentication failure`);
                } else {
                    this._onError(`Invalid data ${data} while waiting for ${PROMPT_USERNAME.toString()}`, true);
                }
                break;

            case STATES.WAIT_CONNECTED:
                if (PROMPT_ERROR_LICENSE.test(data)) {
                    this._onError(`License error received!`, true);
                } else if (PROMPT_CONNECTED.test(data) || PROMPT_MEASURE_UPDATE.test(data)) {
                    // Old versions send data immediately without connect ack
                    // send 0-50% mode
                    this._changeState(STATES.READY);

                    let modeCommand: ConnectionCommand;
                    switch (this.params.analogMode) {
                        case ANALOG_MODES.IOB100toLCN50:
                            modeCommand = COMMANDS.SET_OUTPUT_MODE_0_50_PERCENT;
                            break;
                        case ANALOG_MODES.IOB50toLCN50:
                            modeCommand = COMMANDS.SET_OUTPUT_MODE_0_50_NATIVE;
                            break;
                        case ANALOG_MODES.IOB100toLCN200:
                            modeCommand = COMMANDS.SET_OUTPUT_MODE_0_200_PERCENT;
                            break;
                        case ANALOG_MODES.IOB200toLCN200:
                            modeCommand = COMMANDS.SET_OUTPUT_MODE_0_200_NATIVE;
                            break;
                        default:
                            modeCommand = COMMANDS.SET_OUTPUT_MODE_0_50_PERCENT;
                            break;
                    }

                    this.commandPromiseEx(modeCommand)
                        // Send decimal mode
                        .then(() => this.commandPromiseEx(COMMANDS.SET_DECIMAL_MODE))
                        .then(() => {
                            this.emit('connected');
                            if (PROMPT_MEASURE_UPDATE.test(data)) {
                                // received some data
                                this.emit('data', data);
                            }
                        })
                        .catch(err => this._onError(err, true));
                } else {
                    this._onError(`Invalid data ${data} while waiting for ${PROMPT_CONNECTED.toString()}`);
                }
                break;

            case STATES.READY:
            case STATES.WAIT_RESPONSE:
                if (this.state === STATES.WAIT_RESPONSE && !this.processingCommand) {
                    this._changeState(STATES.READY);
                    this._onError(`Invalid state WAIT_RESPONSE, but no command`);
                }

                if (PROMPT_DISCONNECTED.test(data)) {
                    this._changeState(STATES.WAIT_CONNECTED);
                } else if (PROMPT_ERROR_LICENSE.test(data)) {
                    this._onError(`License error received!`, true);
                } else if (this.processingCommand && PROMPT_ERROR.test(data)) {
                    this._onCommandFinish('cannot process');
                } else if (this.processingCommand && PROMPT_ERROR_PARAM.test(data)) {
                    this._onCommandFinish('invalid parameter');
                } else if (this.processingCommand?.regAnswer && this.processingCommand.regAnswer.test(data)) {
                    this._onCommandFinish(null, data);
                } else {
                    // received some data
                    this.emit('data', data);
                }

                break;

            default:
                this._onError(`Invalid state "${this.state}"`);
                break;
        }
    }

    commandPromiseEx(
        cmd: ConnectionCommand,
        timeout?: number,
        ignoreTimeoutError?: boolean,
    ): Promise<string | undefined> {
        return new Promise((resolve, reject) =>
            this.command(cmd.cmd, cmd.regAnswer, timeout, ignoreTimeoutError, (err, data) =>
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                err ? reject(err) : resolve(data),
            ),
        );
    }

    commandPromise(
        cmd: string,
        regAnswer?: RegExp,
        timeout?: number,
        ignoreTimeoutError?: boolean,
    ): Promise<string | undefined> {
        // The promise is rejected with the plain error text (e.g. 'timeout'), the callers compare it (sic)
        return new Promise((resolve, reject) =>
            this.command(cmd, regAnswer, timeout, ignoreTimeoutError, (err, data) =>
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                err ? reject(err) : resolve(data),
            ),
        );
    }

    command(
        cmd: string,
        regAnswer?: RegExp,
        timeout?: number,
        ignoreTimeoutError?: boolean,
        cb?: CommandCallback,
    ): void {
        const task: CommandTask = {
            cmd,
            regAnswer,
            ts: Date.now(),
            cb,
            timeout,
            ignoreTimeoutError,
        };

        if (
            cmd === COMMANDS.SET_DECIMAL_MODE.cmd ||
            cmd === COMMANDS.SET_OUTPUT_MODE_0_50_PERCENT.cmd ||
            cmd === COMMANDS.SET_OUTPUT_MODE_0_50_NATIVE.cmd ||
            cmd === COMMANDS.SET_OUTPUT_MODE_0_200_PERCENT.cmd ||
            cmd === COMMANDS.SET_OUTPUT_MODE_0_200_NATIVE.cmd
        ) {
            this.requests.unshift(task);
        } else {
            this.requests.push(task);
        }

        if (this.requests.length === 1) {
            this._processCommands();
        }
    }

    private _onCommandFinish(err: string | null, data?: string): void {
        const processingCommand = this.processingCommand;
        if (processingCommand) {
            if (processingCommand.timer) {
                clearTimeout(processingCommand.timer);
            }
            if (typeof processingCommand.cb === 'function') {
                if (processingCommand.ignoreTimeoutError && err === 'timeout') {
                    processingCommand.cb(null, data);
                } else {
                    processingCommand.cb(err, data);
                }
            }
        }
        this.processingCommand = null;

        this._changeState(STATES.READY);
    }

    private _processCommands(): void {
        if (!this.requests.length) {
            return;
        }
        if (this.state !== STATES.READY) {
            return;
        }

        const cmd = this.requests.shift()!;
        cmd.ts = Date.now();
        this.processingCommand = cmd;

        if (cmd.cb) {
            const cb = cmd.cb;
            cmd.timer = setTimeout(() => {
                cmd.timer = null;
                if (this.state === STATES.WAIT_RESPONSE && this.processingCommand === cmd) {
                    this._onCommandFinish('timeout');
                } else {
                    cb('timeout');
                }
            }, cmd.timeout || this.params.defaultTimeout);

            this._changeState(STATES.WAIT_RESPONSE);

            this._send(cmd.cmd)
                .then(() => this.debug && this.logger.debug(`[CONN] command sent: ${cmd.cmd}`))
                .catch(e => this._onError(e, true));
        } else {
            this._send(cmd.cmd)
                .then(() => this.debug && this.logger.debug(`[CONN] command sent (no callback): ${cmd.cmd}`))
                .catch(e => this._onError(e, true));
        }
    }

    private _send(cmd: string): Promise<void> {
        if (!cmd) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject('No data');
        }
        if (cmd[cmd.length - 1] !== '\n') {
            cmd += '\n';
        }

        return new Promise((resolve, reject) => {
            if (this.socket) {
                this._resetPingTimer();
                this.socket.write(cmd, () => resolve());
            } else {
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                reject('Socket not exists while sending');
            }
        });
    }

    destroy(isReconnect?: boolean, cb?: () => void): void {
        this._changeState(STATES.CONNECTING);

        this.shutdown = true;
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }

        if (this.pingTimeout) {
            clearTimeout(this.pingTimeout);
            this.pingTimeout = null;
        }

        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        cb?.();

        if (isReconnect) {
            setTimeout(() => {
                this.shutdown = false;
                this.connectTimeout ||= setTimeout(() => this.connect(), this.params.reconnectTimeout);
            }, 500);
        }
    }

    isConnected(): boolean {
        return this.state >= STATES.READY && this.state !== STATES.DISCONNECT;
    }

    getState(): ConnectionState {
        return this.state;
    }

    isReady(): boolean {
        return this.ready;
    }
}
