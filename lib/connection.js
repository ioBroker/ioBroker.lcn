/*
 * Copyright (c) 2018-2024 bluefox <dogafox@gmail.com> CC-BY-NC-4.0
 * Copyright (c) 2025 bluefox <dogafox@gmail.com> MIT
 *
 */
'use strict';

const { EventEmitter } = require('node:events');
const net = require('node:net');
const ANALOG_MODES = require('./analogModes');

const logger = {
    log: data => console.log(data),
    debug: data => console.log(data),
    warn: data => console.warn(data),
    error: data => console.error(data),
};

const STATES = {
    CONNECTING: 0,
    WAIT_PROMPT: 1, // LCN-PCK/IP 1.0
    WAIT_USER: 2, // Username:
    WAIT_PASS: 3, // Password:
    WAIT_AUTH_OK: 4, // OK / Authentication failed.
    WAIT_CONNECTED: 5, // $io:#LCN:connected
    READY: 6,
    WAIT_RESPONSE: 7, // wait response for command
    DISCONNECT: 8, // Disconnecting
};

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

const COMMANDS = {
    SET_OUTPUT_MODE_0_50_PERCENT: { cmd: '!OM0P', regAnswer: /^\(0\.\.50-mode percent\)$/ },
    SET_OUTPUT_MODE_0_50_NATIVE: { cmd: '!OM0N', regAnswer: /^\(0\.\.50-mode native\)$/ },
    SET_OUTPUT_MODE_0_200_PERCENT: { cmd: '!OM1P', regAnswer: /^\(0\.\.200-mode percent\)$/ },
    SET_OUTPUT_MODE_0_200_NATIVE: { cmd: '!OM1N', regAnswer: /^\(0\.\.200-mode native\)$/ },
    SET_DECIMAL_MODE: { cmd: '!CHD', regAnswer: /^\(dec-mode\)$/ },
    PING: { cmd: '^ping', regAnswer: /^\^ping(\d+)-?/ }, // ^ping1<LF>
};

function formatNumber(addr) {
    addr = parseInt(addr, 10);
    if (addr < 10) {
        return `00${addr}`;
    }
    if (addr < 100) {
        return `0${addr}`;
    }
    if (addr > 255) {
        throw new Error(`Invalid address ${addr}`);
    }
    return addr.toString();
}

// events
// - connected
// - disconnected
// - state
// - error
// - data
// - version
// - serial

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

// define a constructor (object) and inherit EventEmitter functions
class Connection extends EventEmitter {
    static state2text(state) {
        return Object.keys(STATES).find(s => STATES[s] === state) || `UNKNOWN(${state})`;
    }

    constructor(options) {
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
            function (segment, module) {
                return `S${formatNumber(segment)}.M${formatNumber(module)}`;
            };
        this.debug = !!options.debug;

        if (this.params.pingInterval < this.params.pingTimeout * 2) {
            this.params.pingInterval = this.params.pingTimeout * 10;
        }

        this.logger = options.logger || logger;
        this.connectTimeout = null;
        this.requests = [];
        this.buffer = '';
        this.shutdown = false;
        this.state = STATES.CONNECTING;
        this.pingTimeout = null;
        this.pingIndex = 0;
        this.connect();
    }

    connect() {
        this.ready = false;

        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }

        this.socket = net.createConnection(this.params, () => {
            // on Connect
            this._changeState(STATES.WAIT_PROMPT, this.params.connectTimeout);
            this.pingTimeout = this.pingTimeout || setTimeout(() => this._sendPing(), this.params.pingInterval);
        });

        this.socket.on('error', error => {
            this.buffer = null;
            if (this.socket) {
                this.emit('error', error);
                this.socket.destroy(true);
                this.socket = null;
            }
        });

        this.socket.on('end', () => {
            this.buffer = null;
            if (this.socket) {
                this.socket.destroy(true);
                this.socket = null;
                this.emit('end');
            }
            !this.shutdown && this.destroy(true);
        });

        this.socket.on('close', () => {
            this.buffer = null;
            if (this.socket) {
                this.socket.destroy(true);
                this.socket = null;
                this.emit('close');
            }
            !this.shutdown && this.destroy(true);
        });

        this.socket.on('data', data => {
            if (this.shutdown) {
                return;
            }
            if (!data) {
                this.logger.warn('[CONN] Received null data');
                return;
            }

            this.buffer += data.toString();
            const lines = this.buffer.split(/\r\n|\n\r|\n|\r/); // any combinations of
            this.buffer = lines[lines.length - 1] || ''; // save the last not full command

            for (let line = 0; line < lines.length - 1; line++) {
                if (lines[line]) {
                    this._processLine(lines[line]);
                }
            }
        });
    }

    _onError(err, reconnect) {
        this.emit('error', err);
        this.logger.error(`[CONN] ${err}. Reconnecting...`);

        if (reconnect && !this.shutdown) {
            this.destroy(true);
        }
    }

    _changeState(newState, timeout) {
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

    _resetPingTimer() {
        if (this.pingTimeout) {
            clearTimeout(this.pingTimeout);
            this.pingTimeout = setTimeout(() => this._sendPing(), this.params.pingInterval);
        }
    }

    _sendPing() {
        this.pingIndex++;
        this.pingIndex = this.pingIndex % 100;
        this.pingTimeout = null;
        this.commandPromise(COMMANDS.PING.cmd + this.pingIndex, COMMANDS.PING.regAnswer, this.params.pingTimeout)
            .then(data => {
                const m = data.match(COMMANDS.PING.regAnswer);
                if (!m || parseInt(m[1], 10) !== this.pingIndex) {
                    this._onError(`Ping mismatch expected ${this.pingIndex}, received ${data}`, true);
                } else {
                    this.pingTimeout = setTimeout(() => this._sendPing(), this.params.pingInterval);
                }
            })
            .catch(() => this._onError('Ping timeout', true));
    }

    _processLine(data) {
        this.debug && this.logger.debug(`[CONN] received: ${data}`);

        switch (this.state) {
            case STATES.CONNECTING:
                this._onError('Received data while connecting');
                break;

            case STATES.WAIT_PROMPT:
                if (data.match(PROMPT_VERSION)) {
                    this._changeState(STATES.WAIT_USER, this.params.connectTimeout);
                } else {
                    this._onError(`Invalid data ${data} while waiting for VERSION`, true);
                }
                break;

            case STATES.WAIT_USER:
                if (data.match(PROMPT_USERNAME)) {
                    this._changeState(STATES.WAIT_PASS, this.params.connectTimeout);

                    // send username
                    this._send(this.params.user)
                        .then(() => {})
                        .catch(e => this._onError(e, true));
                } else {
                    this._onError(`Invalid data ${data} while waiting for ${PROMPT_USERNAME}`, true);
                }
                break;

            case STATES.WAIT_PASS:
                if (data.match(PROMPT_PASSWORD)) {
                    this._changeState(STATES.WAIT_AUTH_OK, this.params.connectTimeout);

                    // send password
                    this._send(this.params.password)
                        .then(() => {})
                        .catch(e => this._onError(e, true));
                } else {
                    this._onError(`Invalid data ${data} while waiting for ${PROMPT_USERNAME}`, true);
                }
                break;

            case STATES.WAIT_AUTH_OK:
                if (data.match(PROMPT_AUTH_OK)) {
                    this._changeState(STATES.WAIT_CONNECTED, this.params.connectTimeout);
                } else if (data === PROMPT_AUTH_FAILED) {
                    this._onError(`Authentication failure`);
                } else {
                    this._onError(`Invalid data ${data} while waiting for ${PROMPT_USERNAME}`, true);
                }
                break;

            case STATES.WAIT_CONNECTED:
                if (data.match(PROMPT_ERROR_LICENSE)) {
                    this._onError(`License error received!`, true);
                } else if (data.match(PROMPT_CONNECTED) || data.match(PROMPT_MEASURE_UPDATE)) {
                    // Old versions send data immediately without connect ack
                    // send 0-50% mode
                    this._changeState(STATES.READY);

                    let modeCommand;
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
                            if (data.match(PROMPT_MEASURE_UPDATE)) {
                                // received some data
                                this.emit('data', data);
                            }
                        })
                        .catch(err => this._onError(err, true));
                } else {
                    this._onError(`Invalid data ${data} while waiting for ${PROMPT_CONNECTED}`);
                }
                break;

            case STATES.READY:
            case STATES.WAIT_RESPONSE:
                if (this.state === STATES.WAIT_RESPONSE && !this.processingCommand) {
                    this._changeState(STATES.READY);
                    this._onError(`Invalid state WAIT_RESPONSE, but no command`);
                }

                if (data.match(PROMPT_DISCONNECTED)) {
                    this._changeState(STATES.WAIT_CONNECTED);
                } else if (data.match(PROMPT_ERROR_LICENSE)) {
                    this._onError(`License error received!`, true);
                } else if (this.processingCommand && data.match(PROMPT_ERROR)) {
                    this._onCommandFinish('cannot process');
                } else if (this.processingCommand && data.match(PROMPT_ERROR_PARAM)) {
                    this._onCommandFinish('invalid parameter');
                } else if (
                    this.processingCommand &&
                    this.processingCommand.regAnswer &&
                    data.match(this.processingCommand.regAnswer)
                ) {
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

    commandPromiseEx(cmd, timeout, ignoreTimeoutError) {
        return new Promise((resolve, reject) =>
            this.command(cmd.cmd, cmd.regAnswer, timeout, ignoreTimeoutError, (err, data) =>
                err ? reject(err) : resolve(data),
            ),
        );
    }

    commandEx(cmd, timeout, ignoreTimeoutError, cb) {
        if (typeof ignoreTimeoutError === 'function') {
            cb = ignoreTimeoutError;
            ignoreTimeoutError = false;
        }
        if (typeof timeout === 'function') {
            cb = timeout;
            timeout = this.params.defaultTimeout;
        }
        return this.command(cmd.cmd, cmd.regAnswer, timeout, ignoreTimeoutError, cb);
    }

    commandPromise(cmd, regAnswer, timeout, ignoreTimeoutError) {
        return new Promise((resolve, reject) =>
            this.command(cmd, regAnswer, timeout, ignoreTimeoutError, (err, data) =>
                err ? reject(err) : resolve(data),
            ),
        );
    }

    command(cmd, regAnswer, timeout, ignoreTimeoutError, cb) {
        if (typeof ignoreTimeoutError === 'function') {
            cb = ignoreTimeoutError;
            ignoreTimeoutError = false;
        }
        if (typeof timeout === 'function') {
            cb = timeout;
            timeout = this.params.defaultTimeout;
        }
        const task = {
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

        this.requests.length === 1 && this._processCommands();
    }

    _onCommandFinish(err, data) {
        this.processingCommand.timer && clearTimeout(this.processingCommand.timer);
        if (typeof this.processingCommand.cb === 'function') {
            if (this.processingCommand.ignoreTimeoutError && err === 'timeout') {
                this.processingCommand.cb(null, data);
            } else {
                this.processingCommand.cb(err, data);
            }
        }
        this.processingCommand = null;

        this._changeState(STATES.READY);
    }

    _processCommands() {
        if (!this.requests.length) {
            return;
        }
        if (this.state !== STATES.READY) {
            return;
        }

        const cmd = this.requests.shift();
        cmd.ts = Date.now();
        this.processingCommand = cmd;

        if (cmd.cb) {
            cmd.timer = setTimeout(
                _cmd => {
                    _cmd.timer = null;
                    if (this.state === STATES.WAIT_RESPONSE && this.processingCommand === cmd) {
                        this._onCommandFinish('timeout');
                    } else {
                        _cmd.cb('timeout');
                    }
                },
                cmd.timeout || this.params.defaultTimeout,
                cmd,
            );

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

    _send(cmd) {
        if (typeof cmd === 'object') {
            cmd = cmd.cmd;
        }
        if (!cmd) {
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
                reject('Socket not exists while sending');
            }
        });
    }

    destroy(isReconnect, cb) {
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
            this.socket.destroy(cb);
            cb = null;
            this.socket = null;
        } else {
            cb && cb();
        }

        isReconnect &&
            setTimeout(() => {
                this.shutdown = false;
                if (!this.connectTimeout) {
                    this.connectTimeout = setTimeout(() => this.connect(), this.params.reconnectTimeout);
                }
            }, 500);
    }

    isConnected() {
        return this.state >= STATES.READY && this.state !== STATES.DISCONNECT;
    }

    getState() {
        return this.state;
    }
}

module.exports = {
    Connection,
    STATES,
};
