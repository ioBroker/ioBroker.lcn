/*
 * Copyright (c) 2018-2024 bluefox <dogafox@gmail.com> CC-BY-NC-4.0
 * Copyright (c) 2025 bluefox <dogafox@gmail.com> MIT
 *
 */
'use strict';
const { EventEmitter } = require('node:events');
const { Connection } = require('./connection');
const { COMMANDS, CMDS } = require('./cmds');

// events
//  - connected
//  - disconnected
//  - update
//  - scan
const SCAN_STEP = {
    INACTIVE: 0,
    SCANNING: 1,
    READING: 2,
};

class LCN extends EventEmitter {
    constructor(options) {
        super();
        this.logger = options.logger;
        this.segment = options.segment || 0;

        if (!options) {
            throw new Error('No options provided');
        }
        this.connected = false;
        this.scan = null;
        // init parser with valid mode
        CMDS.setAnalogMode(options.analogMode || 1);
        this.resolveName =
            options.resolveName ||
            function (segment, module) {
                return `S${CMDS.formatNumber(segment)}.M${CMDS.formatNumber(module)}`;
            };
        this.scanResponseTimeout = options.scanResponseTimeout || 1000;

        this.initConnection(options);
    }

    initConnection(options) {
        this.conn = new Connection(options);
        this.conn.on('connected', () => {
            if (!this.connected) {
                this.connected = true;
                this.emit('connected');
            }
        });
        this.conn.on('disconnected', () => {
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

        this.conn.on('data', data => {
            this._commands = this._commands || Object.keys(COMMANDS);

            const cmd = this._commands.find(_cmd => data.match(COMMANDS[_cmd].detect));
            if (cmd) {
                const parsed = COMMANDS[cmd].parse(data);
                if (parsed) {
                    parsed.forEach(state => {
                        this.logger.debug(
                            `[LCN][RECEIVED] ${this.resolveName(state.segment, state.module)} - ${JSON.stringify(state)}`,
                        );

                        if (state.success === undefined && !state.error) {
                            if (this.scan && state.segment === this.scan.segment && this.scan.found[state.module]) {
                                this.scan.found[state.module].states = this.scan.found[state.module].states || [];
                                this.scan.found[state.module].states.push(state);
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

        this.conn.on('state', _state => {
            // this.logger.debug('new state: ' + Connection.state2text(state));
        });
        this.conn.on('error', _error => {
            // this.logger.debug('new state: ' + Connection.state2text(state));
        });
    }

    scanSegment(minScan, maxScan, segment) {
        minScan = minScan || 3;
        maxScan = maxScan || 250;
        segment = segment || this.segment;

        if (this.scan) {
            return Promise.reject(`scan for segment ${this.scan.segment} already running`);
        }
        if (!this.connected) {
            return Promise.reject('LCN not connected');
        }

        return new Promise((resolve, reject) => {
            this.scan = {
                segment,
                min: minScan,
                max: maxScan,
                module: minScan,
                found: {},
                resolve,
                reject,
            };
            this._processScan();
        });
    }

    _processNextScan() {
        this.scan.module++;
        if (this.scan.module > this.scan.max) {
            this.scan.module = -1;
            setTimeout(() => this._processScanRead(), 100);
        } else {
            setTimeout(() => this._processScan(), 100);
        }
    }

    _processScan() {
        this.logger.debug(`[LCN][SCAN0] Detect ${this.scan.segment}:${this.scan.module}...`);
        this.emit('scan', {
            step: SCAN_STEP.SCANNING,
            progress: this.scan.module,
            found: Object.keys(this.scan.found).length,
        });

        this.conn
            .commandPromise(
                COMMANDS.NAME.generate({ segment: this.scan.segment, module: this.scan.module }, 'name', 1),
                COMMANDS.NAME.detect,
                this.scanResponseTimeout,
            )
            .then(data => {
                // =M000006.N1Name part1
                const parsed = COMMANDS.NAME.parse(data)[0];
                if (parsed) {
                    if (parsed.segment !== this.scan.segment || parsed.module !== this.scan.module) {
                        // very late answer for other request
                        this.logger.warn(
                            `[LCN][SCAN0] late answer for scan. Please increase default response timeout!`,
                        );
                    }
                    this.logger.debug(`[LCN][SCAN0] Detected ${parsed.segment}:${parsed.module}!`);
                    this.scan.found[parsed.module] = this.scan.found[parsed.module] || {};
                    this.scan.found[parsed.module].name = parsed.status;
                    this.scan.found[parsed.module].comment = this.scan.found[parsed.module].comment || '';
                }
                this._processNextScan();
            })
            .catch(err => {
                this.logger.debug(`[LCN][SCAN0] Not detected ${this.scan.segment}:${this.scan.module}: ${err}`);
                if (err === 'timeout') {
                    this._processNextScan();
                } else {
                    this.logger.error(`[LCN][SCAN0] Scan interrupted, because: ${err}`);
                    this.scan.resolve(this.scan.found);
                    this.scan = null;
                }
            });
    }

    _processNextRead() {
        const modules = Object.keys(this.scan.found);
        // get the next address
        this.scan.module = parseInt(
            modules.find(m => parseInt(m, 10) > this.scan.module),
            10,
        );

        if (!this.scan.module) {
            // wait 2 seconds till answers will arrive
            setTimeout(() => {
                this.emit('scan', { step: SCAN_STEP.INACTIVE, progress: this.scan.module, found: modules.length });
                this.logger.info(`[LCN] Scan finished. Found ${modules.length} modules`);
                for (const module in this.scan.found) {
                    if (Object.prototype.hasOwnProperty.call(this.scan.found, module)) {
                        this.scan.found[module].segment = parseInt(this.scan.segment, 10);
                        this.scan.found[module].module = parseInt(module, 10);
                    }
                }

                this.scan.resolve(this.scan.found);
                this.scan = null;
            }, 2000);
        } else {
            this.scan.module = parseInt(this.scan.module, 10);
            setTimeout(() => this._processScanRead(), 100);
        }
    }

    _processScanRead() {
        if (this.scan.module === -1) {
            const modules = Object.keys(this.scan.found);
            if (!modules.length) {
                this.emit('scan', { step: SCAN_STEP.INACTIVE, progress: this.scan.module, found: 0 });
                this.logger.info('[LCN][SCAN1] Scan stopped. No one module found');
                this.scan.resolve(this.scan.found);
                this.scan = null;
                return;
            }
            this.scan.module = parseInt(modules[0], 10);
        }

        this.emit('scan', {
            step: SCAN_STEP.READING,
            progress: this.scan.module,
            found: Object.keys(this.scan.found).length,
        });
        this.logger.debug(`[LCN][SCAN1] Read ${this.scan.segment}:${this.scan.module}...`);
        this.conn
            .commandPromise(
                COMMANDS.NAME.generate({ segment: this.scan.segment, module: this.scan.module }, 'name', 2),
                COMMANDS.NAME.detect,
                this.scanResponseTimeout,
                true,
            )
            .then(data => {
                if (data) {
                    const parsed = COMMANDS.NAME.parse(data)[0];
                    if (parsed.module !== this.scan.module) {
                        this.logger.warn(
                            `[LCN][SCAN1] received name answer for other module: expected - ${this.scan.module}, received - ${parsed.module}. Increase response timeout in config. This answer will be ignored`,
                        );
                        throw new Error('Too slow answers');
                    } else {
                        this.scan.found[parsed.module] = this.scan.found[parsed.module] || {
                            name: '',
                            comment: '',
                            states: [],
                        };
                        this.scan.found[parsed.module].name += parsed.status || '';
                        this.scan.found[parsed.module].name = this.scan.found[parsed.module].name.trim();
                        this.logger.debug(
                            `[LCN][SCAN1] Name2 ${parsed.segment}:${parsed.module}: ${this.scan.found[parsed.module].name}`,
                        );
                    }
                } else {
                    this.logger.debug(`[LCN][SCAN1] Name2 timeout`);
                }

                return this.conn.commandPromise(
                    COMMANDS.NAME.generate({ segment: this.scan.segment, module: this.scan.module }, 'comment', 1),
                    COMMANDS.NAME.detect,
                    this.scanResponseTimeout,
                    true,
                );
            })
            .then(data => {
                if (data) {
                    const parsed = COMMANDS.NAME.parse(data)[0];
                    if (parsed.module !== this.scan.module) {
                        this.logger.warn(
                            `[LCN][SCAN1] received Comment1 answer for other module: expected - ${this.scan.module}, received - ${parsed.module}. Increase response timeout in config. This answer will be ignored`,
                        );
                        throw new Error('Too slow answers');
                    } else {
                        this.scan.found[parsed.module].comment = parsed.status || '';
                        this.logger.debug(
                            `[LCN][SCAN1] Comment1 ${parsed.segment}:${parsed.module}: ${this.scan.found[parsed.module].comment}`,
                        );
                    }
                } else {
                    this.logger.debug(`[LCN][SCAN1] Comment1 timeout`);
                }

                return this.conn.commandPromise(
                    COMMANDS.NAME.generate({ segment: this.scan.segment, module: this.scan.module }, 'comment', 2),
                    COMMANDS.NAME.detect,
                    this.scanResponseTimeout,
                    true,
                );
            })
            .then(data => {
                if (data) {
                    const parsed = COMMANDS.NAME.parse(data)[0];
                    if (parsed.module !== this.scan.module) {
                        this.logger.warn(
                            `[LCN][SCAN1] received Comment2 answer for other module: expected - ${this.scan.module}, received - ${parsed.module}. Increase response timeout in config. This answer will be ignored`,
                        );
                        throw new Error('Too slow answers');
                    } else {
                        this.scan.found[this.scan.module].comment += parsed.status || '';
                        this.logger.debug(
                            `[LCN][SCAN1] Comment2 ${this.scan.segment}:${this.scan.module}: ${this.scan.found[this.scan.module].comment}`,
                        );
                    }
                } else {
                    this.logger.debug(`[LCN][SCAN1] Comment2 timeout`);
                }
                return this.conn.commandPromise(
                    COMMANDS.NAME.generate({ segment: this.scan.segment, module: this.scan.module }, 'comment', 3),
                    COMMANDS.NAME.detect,
                    this.scanResponseTimeout,
                    true,
                );
            })
            .then(data => {
                if (data) {
                    const parsed = COMMANDS.NAME.parse(data)[0];
                    if (parsed.module !== this.scan.module) {
                        this.logger.warn(
                            `[LCN][SCAN1] received Comment3 answer for other module: expected - ${this.scan.module}, received - ${parsed.module}. Increase response timeout in config. This answer will be ignored`,
                        );
                        throw new Error('Too slow answers');
                    } else {
                        this.scan.found[this.scan.module].comment += parsed.status || '';
                        this.scan.found[this.scan.module].comment = this.scan.found[this.scan.module].comment.trim();
                        this.logger.debug(
                            `[LCN][SCAN1] Comment3 ${this.scan.segment}:${this.scan.module}: ${this.scan.found[this.scan.module].comment}`,
                        );
                    }
                } else {
                    this.logger.debug(`[LCN][SCAN1] Comment3 timeout`);
                }
                return this.conn.commandPromise(
                    COMMANDS.SERIAL.generate({ segment: this.scan.segment, module: this.scan.module }),
                    COMMANDS.SERIAL.detect,
                    this.scanResponseTimeout,
                    true,
                );
            })
            .then(data => {
                if (data) {
                    const parsed = COMMANDS.SERIAL.parse(data)[0];
                    if (parsed.module !== this.scan.module) {
                        this.logger.warn(
                            `[LCN][SCAN1] received Serial answer for other module: expected - ${this.scan.module}, received - ${parsed.module}. Increase response timeout in config. This answer will be ignored`,
                        );
                        throw new Error('Too slow answers');
                    } else {
                        this.scan.found[this.scan.module].serial = parsed.serial;
                        this.scan.found[this.scan.module].manufacturer = parsed.manufacturer;
                        this.scan.found[this.scan.module].hwType = parsed.hwType;
                        this.scan.found[this.scan.module].fwVersion = parsed.fwVersion;
                        this.logger.debug(
                            `[LCN][SCAN1] Serial ${this.scan.segment}:${this.scan.module}: ${JSON.stringify(parsed)}`,
                        );
                    }
                } else {
                    this.logger.debug(`[LCN][SCAN1] Serial timeout`);
                }

                for (let i = 1; i < 12; i++) {
                    // answers will be processed in on('data', () =>)
                    this.conn.command(
                        COMMANDS.VAR.generate({ segment: this.scan.segment, module: this.scan.module, input: i }),
                        COMMANDS.VAR.detect,
                        this.scanResponseTimeout,
                        true,
                    );
                }
                return this.conn.commandPromise(
                    COMMANDS.VAR.generate({ segment: this.scan.segment, module: this.scan.module, input: 12 }),
                    COMMANDS.VAR.detect,
                    this.scanResponseTimeout,
                    true,
                );
            })
            .then(data => {
                if (data) {
                    const parsed = COMMANDS.VAR.parse(data);
                    if (parsed[0].module !== this.scan.module) {
                        this.logger.warn(
                            `[LCN][SCAN1] received VAR answer for other module: expected - ${this.scan.module}, received - ${parsed[0].module}. Increase response timeout in config. This answer will be ignored`,
                        );
                        throw new Error('Too slow answers');
                    } else {
                        this.scan.found[this.scan.module].states = this.scan.found[this.scan.module].states || [];
                        parsed.forEach(item => this.scan.found[this.scan.module].states.push(item));

                        this.logger.debug(
                            `[LCN][SCAN1] VAR state ${this.scan.segment}:${this.scan.module}: ${this.scan.found[this.scan.module].states.length}`,
                        );
                    }
                } else {
                    this.logger.debug(`[LCN][SCAN1] VAR timeout`);
                }
                return this.conn.commandPromise(
                    COMMANDS.REGULATOR.generate({ segment: this.scan.segment, module: this.scan.module, input: 1 }),
                    COMMANDS.REGULATOR.detect,
                    this.scanResponseTimeout,
                    true,
                );
            })
            .then(data => {
                if (data) {
                    const parsed = COMMANDS.REGULATOR.parse(data);
                    if (parsed[0].module !== this.scan.module) {
                        this.logger.warn(
                            `[LCN][SCAN1] received REGULATOR1 answer for other module: expected - ${this.scan.module}, received - ${parsed[0].module}. Increase response timeout in config. This answer will be ignored`,
                        );
                        throw new Error('Too slow answers');
                    } else {
                        this.scan.found[this.scan.module].states = this.scan.found[this.scan.module].states || [];
                        parsed.forEach(item => this.scan.found[this.scan.module].states.push(item));

                        this.logger.debug(
                            `[LCN][SCAN1] REGULATOR1 state ${this.scan.segment}:${this.scan.module}: ${this.scan.found[this.scan.module].states.length}`,
                        );
                    }
                } else {
                    this.logger.debug(`[LCN][SCAN1] REGULATOR1 timeout`);
                }
                return this.conn.commandPromise(
                    COMMANDS.REGULATOR.generate({ segment: this.scan.segment, module: this.scan.module, input: 2 }),
                    COMMANDS.REGULATOR.detect,
                    this.scanResponseTimeout,
                    true,
                );
            })
            .then(data => {
                if (data) {
                    const parsed = COMMANDS.REGULATOR.parse(data);
                    if (parsed[0].module !== this.scan.module) {
                        this.logger.warn(
                            `[LCN][SCAN1] received REGULATOR2 answer for other module: expected - ${this.scan.module}, received - ${parsed[0].module}. Increase response timeout in config. This answer will be ignored`,
                        );
                        throw new Error('Too slow answers');
                    } else {
                        this.scan.found[this.scan.module].states = this.scan.found[this.scan.module].states || [];
                        parsed.forEach(item => this.scan.found[this.scan.module].states.push(item));

                        this.logger.debug(
                            `[LCN][SCAN1] REGULATOR2 state ${this.scan.segment}:${this.scan.module}: ${this.scan.found[this.scan.module].states.length}`,
                        );
                    }
                } else {
                    this.logger.debug(`[LCN][SCAN1] REGULATOR2 timeout`);
                }
                return this.conn.commandPromise(
                    COMMANDS.LED_IN.generate({ segment: this.scan.segment, module: this.scan.module }),
                    COMMANDS.LED_IN.detect,
                    this.scanResponseTimeout,
                    true,
                );
            })
            .then(data => {
                if (data) {
                    const items = COMMANDS.LED_IN.parse(data);
                    this.scan.found[this.scan.module].states = this.scan.found[this.scan.module].states || [];
                    items && items.forEach(item => this.scan.found[this.scan.module].states.push(item));

                    this.logger.debug(
                        `[LCN][SCAN1] LED states ${this.scan.segment}:${this.scan.module}: ${this.scan.found[this.scan.module].states.length}`,
                    );

                    // If LEDS detected, do not scan sensors. Only Relays and Analogs
                    return this.conn
                        .commandPromise(
                            COMMANDS.STATUS_R.generate({ segment: this.scan.segment, module: this.scan.module }),
                            COMMANDS.STATUS_R.detect,
                            this.scanResponseTimeout,
                            true,
                        )
                        .then(data => {
                            if (data) {
                                const items = COMMANDS.STATUS_ALL.parse(data);
                                this.scan.found[this.scan.module].states =
                                    this.scan.found[this.scan.module].states || [];
                                items && items.forEach(item => this.scan.found[this.scan.module].states.push(item));
                                this.logger.debug(
                                    `[LCN][SCAN1] Relays ${this.scan.segment}:${this.scan.module}: ${this.scan.found[this.scan.module].states.length}`,
                                );
                            }

                            return this.conn.commandPromise(
                                COMMANDS.STATUS_A.generate({ segment: this.scan.segment, module: this.scan.module }),
                                COMMANDS.STATUS_A.detect,
                                this.scanResponseTimeout,
                                true,
                            );
                        });
                }
                this.logger.debug(`[LCN][SCAN1] LED timeout`);
                return this.conn.commandPromise(
                    COMMANDS.STATUS_ALL.generate({ segment: this.scan.segment, module: this.scan.module }),
                    COMMANDS.STATUS_ALL.detect,
                    this.scanResponseTimeout,
                    true,
                );
            })
            .then(data => {
                if (data) {
                    const items = COMMANDS.STATUS_ALL.parse(data);
                    this.scan.found[this.scan.module].states = this.scan.found[this.scan.module].states || [];
                    items && items.forEach(item => this.scan.found[this.scan.module].states.push(item));
                    this.logger.debug(
                        `[LCN][SCAN1] Status ${this.scan.segment}:${this.scan.module}: ${this.scan.found[this.scan.module].states.length}`,
                    );
                    // make a delay for 1 second, to accept all statuses
                    setTimeout(
                        () => this._processNextRead(),
                        1200 > this.scanResponseTimeout + 200 ? 1200 : this.scanResponseTimeout + 200,
                    );
                } else {
                    this.logger.debug(`[LCN][SCAN1] Status timeout`);
                    setTimeout(() => this._processNextRead(), 100);
                }
            })
            .catch(e => {
                this.logger.error(`[LCN] Cannot read module ${this.scan.module}: ${e}`);

                // make a delay for 1 second, to accept all statuses
                setTimeout(() => this._processNextRead(), 100);
            });
    }

    control(segment, module, cmd, output, value) {
        const generator = COMMANDS[cmd] || COMMANDS[`${cmd}_OUT`];
        if (!generator) {
            return Promise.reject('Unknown command type');
        }
        if (!generator.generate) {
            return Promise.reject(`Unable to control ${cmd}`);
        }

        if (cmd === COMMANDS.DISPLAY_OUT.name) {
            if (!value && value !== 0) {
                return this.conn.commandPromise(
                    generator.generate(
                        {
                            segment: segment,
                            module: module,
                        },
                        output,
                        '',
                    ),
                    generator.detect,
                );
            }
            value = value.toString();
            let text = value.substring(0, 12);
            value = value.substring(12);
            let prevTextLen = text.length;

            return new Promise((resolve, reject) => {
                this.conn.command(
                    generator.generate({ segment: segment, module: module }, output, 1, text),
                    generator.detect,
                    200,
                    true,
                    (err, data) => {
                        if (err) {
                            reject(err);
                        } else {
                            text = value.substring(0, 12);
                            value = value.substring(12);
                            if (text || prevTextLen === 12) {
                                prevTextLen = text.length;
                                this.conn.command(
                                    generator.generate({ segment: segment, module: module }, output, 2, text || ''),
                                    generator.detect,
                                    200,
                                    true,
                                    (err, data) => {
                                        if (err) {
                                            reject(err);
                                        } else {
                                            text = value.substring(0, 12);
                                            value = value.substring(12);
                                            if (text || prevTextLen === 12) {
                                                prevTextLen = text.length;
                                                this.conn.command(
                                                    generator.generate(
                                                        { segment: segment, module: module },
                                                        output,
                                                        3,
                                                        text || '',
                                                    ),
                                                    generator.detect,
                                                    200,
                                                    true,
                                                    (err, data) => {
                                                        if (err) {
                                                            reject(err);
                                                        } else {
                                                            text = value.substring(0, 12);
                                                            value = value.substring(12);
                                                            if (text || prevTextLen === 12) {
                                                                prevTextLen = text.length;
                                                                this.conn.command(
                                                                    generator.generate(
                                                                        { segment: segment, module: module },
                                                                        output,
                                                                        4,
                                                                        text || '',
                                                                    ),
                                                                    generator.detect,
                                                                    200,
                                                                    true,
                                                                    (err, data) => {
                                                                        if (err) {
                                                                            reject(err);
                                                                        } else {
                                                                            text = value.substring(0, 12);
                                                                            if (text || prevTextLen === 12) {
                                                                                this.conn.command(
                                                                                    generator.generate(
                                                                                        {
                                                                                            segment: segment,
                                                                                            module: module,
                                                                                        },
                                                                                        output,
                                                                                        5,
                                                                                        text || '',
                                                                                    ),
                                                                                    generator.detect,
                                                                                    200,
                                                                                    true,
                                                                                    (err, data) => {
                                                                                        if (err) {
                                                                                            reject(err);
                                                                                        } else {
                                                                                            resolve(data);
                                                                                        }
                                                                                    },
                                                                                );
                                                                            } else {
                                                                                return resolve(data);
                                                                            }
                                                                        }
                                                                    },
                                                                );
                                                            } else {
                                                                return resolve(data);
                                                            }
                                                        }
                                                    },
                                                );
                                            } else {
                                                return resolve(data);
                                            }
                                        }
                                    },
                                );
                            } else {
                                return resolve(data);
                            }
                        }
                    },
                );
            });
        }
        return this.conn.commandPromise(
            generator.generate(
                {
                    segment: segment,
                    module: module,
                },
                output,
                value,
            ),
            generator.detect,
        );
    }

    /**
     * Read status
     *
     * @param {number} segment
     * @param {number} module
     * @param {string} operation L - LED, S - Sensors, A - Analog, R - Relay, AR - Analog+Relay, ALL - all
     */
    read(segment, module, operation) {
        if (operation === 'L') {
            return this.conn.command(COMMANDS.LED_IN.generate({ segment, module }));
        } else if (operation === 'R') {
            return this.conn.command(COMMANDS.STATUS_R.generate({ segment, module }));
        } else if (operation === 'RA' || operation === 'AR') {
            this.conn.command(COMMANDS.STATUS_R.generate({ segment, module }));
            return this.conn.command(COMMANDS.STATUS_A.generate({ segment, module }));
        } else if (operation === 'V') {
            this.conn.command(COMMANDS.VAR.generate({ segment, module, input: 1 }));
            this.conn.command(COMMANDS.VAR.generate({ segment, module, input: 2 }));
            this.conn.command(COMMANDS.VAR.generate({ segment, module, input: 3 }));
            this.conn.command(COMMANDS.VAR.generate({ segment, module, input: 4 }));
            this.conn.command(COMMANDS.VAR.generate({ segment, module, input: 5 }));
            this.conn.command(COMMANDS.VAR.generate({ segment, module, input: 6 }));
            this.conn.command(COMMANDS.VAR.generate({ segment, module, input: 7 }));
            this.conn.command(COMMANDS.VAR.generate({ segment, module, input: 8 }));
            this.conn.command(COMMANDS.VAR.generate({ segment, module, input: 9 }));
            this.conn.command(COMMANDS.VAR.generate({ segment, module, input: 10 }));
            this.conn.command(COMMANDS.VAR.generate({ segment, module, input: 11 }));
            return this.conn.command(COMMANDS.VAR.generate({ segment, module, input: 12 }));
        } else if (operation === 'C') {
            this.conn.command(COMMANDS.COUNTER.generate({ segment, module, input: 1 }));
            this.conn.command(COMMANDS.COUNTER.generate({ segment, module, input: 2 }));
            this.conn.command(COMMANDS.COUNTER.generate({ segment, module, input: 3 }));
            return this.conn.command(COMMANDS.COUNTER.generate({ segment, module, input: 4 }));
        } else if (operation === 'SE') {
            this.conn.command(COMMANDS.SETTING.generate({ segment, module, input: 1 }));
            this.conn.command(COMMANDS.SETTING.generate({ segment, module, input: 2 }));
            return this.conn.command(COMMANDS.SETTING.generate({ segment, module, input: 3 }));
        } else if (operation === 'A') {
            return this.conn.command(COMMANDS.STATUS_A.generate({ segment, module }));
        } else if (operation === 'S') {
            return this.conn.command(COMMANDS.STATUS_S.generate({ segment, module }));
        }
        this.conn.command(COMMANDS.STATUS_ALL.generate({ segment, module }));
        return this.conn.command(COMMANDS.STATUS_ALL.generate({ segment, module }));
    }

    scanModules(tasks, cb) {
        if (this.scan) {
            cb && cb('[LCN] Read stopped, because scan is active');
        } else if (!tasks && !tasks.length) {
            cb && cb();
        } else {
            const task = tasks.shift();
            const native = task.native;
            delete task.native;

            native.leds && this.conn.command(COMMANDS.LED_IN.generate(task));
            native.relays && this.conn.command(COMMANDS.STATUS_R.generate(task));
            native.analogs && this.conn.command(COMMANDS.STATUS_A.generate(task));
            native.sensors && this.conn.command(COMMANDS.STATUS_S.generate(task));
            if (native.regulator) {
                for (let i = 1; i <= 2; i++) {
                    task.input = i;
                    this.conn.command(COMMANDS.REGULATOR.generate(task));
                }
            }

            if (native.vars) {
                for (let i = 1; i <= 12; i++) {
                    task.input = i;
                    this.conn.command(COMMANDS.VAR.generate(task));
                }
            }
            if (native.counters) {
                for (let i = 1; i <= 4; i++) {
                    task.input = i;
                    this.conn.command(COMMANDS.COUNTER.generate(task));
                }
            }

            if (tasks.length) {
                setTimeout(() => this.scanModules(tasks, cb), 1200);
            } else {
                cb && cb();
            }
        }
    }

    destroy(cb) {
        if (this.conn) {
            this.conn.destroy(cb);
        } else {
            cb && cb();
        }
    }
}

module.exports = {
    LCN,
    SCAN_STEP,
};
