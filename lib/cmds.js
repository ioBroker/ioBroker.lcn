/*
 * Copyright (c) 2018-2024 bluefox <dogafox@gmail.com> CC-BY-NC-4.0
 * Copyright (c) 2025 bluefox <dogafox@gmail.com> MIT
 *
 */
'use strict';
const ACK_ERRORS = {
    5: 'Unknown',
    6: 'Number of parameters wrong',
    7: 'Value for parameter wrong',
    8: 'Command not allowed at the moment',
    9: 'Not approved according to programming',
    10: 'Module unsuitable',
    11: 'Periphery is missing',
    12: 'Programming mode required',
    14: 'Fuse (230V) broken',
};
const detectAck = /^-M\d\d\d\d\d\d!$|^-M\d\d\d\d\d\d\d\d\d$/;
const detectMotor = /^=M(\d\d\d)(\d\d\d)\.RM/;
const detectLEDs = /^=M(\d\d\d)(\d\d\d)\.TL/;
const detectNameComment = /^=M(\d\d\d)(\d\d\d)\.[NK]\d/;
const detectSegmentRepeater = /^=G(\d\d\d)(\d\d\d)\.SK\d\d\d/;
const detectStatus = /^:M(\d\d\d)(\d\d\d)\.?[ARB]/;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const detectBinaryStatus = /^:M(\d\d\d)(\d\d\d)\.?Bx/;
const detectSum = /^:M(\d\d\d)(\d\d\d)S\d\d\d\d/;
const detectIR = /^=M(\d\d\d)(\d\d\d)\.ZI/;
const detectFingerSensor = /^=M(\d\d\d)(\d\d\d)\.ZT/;
const detectVariables = /^%M(\d\d\d)(\d\d\d)\.A/; // %M000005.A01000477
const detectCounters = /^%M(\d\d\d)(\d\d\d)\.C/;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const detectSetValue = /^%M(\d\d\d)(\d\d\d)\.S[12]\d\d\d\d\d$/;
const detectMeasure = /^%M(\d\d\d)(\d\d\d)\.\d/; // %M000005.65535
const detectLimits = /^%M(\d\d\d)(\d\d\d)\.T\d\d/; // %M000111.T2401200
const detectGetSetValues = /^%M(\d\d\d)(\d\d\d)\.S\d\d\d\d\d\d$/; // %M000111.S101200

const ANALOG_MODES = require('./analogModes');

const MANUFACTURERS = {
    1: 'Issendorff',
    3: 'LCNvision (IOS)',
    16: 'BEGA',
};

const HW_TYPES = {
    4: 'CMDS-UP', // UP Module
    6: 'CMDS-PROFIMODUL', // ??
    7: 'CMDS-DI12',
    8: 'CMDS-HU',
    9: 'CMDS-SH',
    10: 'CMDS-UP',
    14: 'CMDS-LD',
    15: 'CMDS-SHplus',
    20: 'CMDS-SHS',
    21: 'CMDS-ESD',
    11: 'CMDS-UPP',
    17: 'CMDS-UPS',
    18: 'CMDS-UP24',
    19: 'IOS-GTM', // Tablet
    12: 'CMDS-SK', // Segmentkoppler
    22: 'BEGA-EB2', // ??
};
const detectSerial = /^=M(\d\d\d)(\d\d\d)\.SN/;

class CMDS {
    /**
     * set analog mode
     *
     * @param {number} analogMode 1-4
     */
    static setAnalogMode(analogMode) {
        CMDS.analogMode = analogMode;
    }
    /** get analog mode */
    static getAnalogMode() {
        return CMDS.analogMode;
    }
    static formatNumber(addr) {
        addr = parseInt(addr, 10);
        addr = addr.toString().padStart(3, '0');
        if (addr > 255) {
            throw new Error(`Invalid address ${addr}`);
        }
        return addr;
    }

    static getAddress(segment, module, isGroup) {
        return (isGroup ? 'G' : 'M') + CMDS.formatNumber(segment) + CMDS.formatNumber(module);
    }

    // options
    // {
    //    segment: int
    //    module: int
    //    isGroup: boolean
    // }
    //
    static buildAddress(address, withAck, cmd, payload) {
        let text = `>${address.isGroup ? 'G' : 'M'}${CMDS.formatNumber(address.segment)}${CMDS.formatNumber(address.module)}${withAck ? '!' : '.'}`;
        return text + cmd + (payload !== undefined ? payload : '');
    }

    /**
     * Control analog output
     *
     * @param {object} address address info {segment, module, isGroup}
     * @param {number} output output number 1-4
     * @param {number} level 0-100 %
     * @param {number} time 0-250
     */
    static buildAnalog(address, output, level, time) {
        time = time || 0;
        if (level > 100) {
            level = 100;
        }
        if (level < 0) {
            level = 0;
        }
        if (time > 255) {
            time = 255;
        }
        if (time < 0) {
            time = 0;
        }

        switch (CMDS.analogMode) {
            case ANALOG_MODES.IOB200toLCN200:
                level *= 2;
                break;
            case ANALOG_MODES.IOB50toLCN50:
                level = Math.round(level / 2);
                break;
        }

        return CMDS.buildAddress(address, true, `A${output}DI`, CMDS.formatNumber(level) + CMDS.formatNumber(time));
    }

    static parseAck(data) {
        // 01234567890123456789012345678901234567890123456
        // -Msssaaa!
        // -Msssaaaddd

        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        const ack = data[8];
        if (ack === '!') {
            return [
                {
                    segment,
                    module,
                    success: true,
                },
            ];
        }
        const error = parseInt(ack, 10);
        return [
            {
                segment,
                module,
                error: ACK_ERRORS[error] || error,
            },
        ];
    }
    /**
     * Control binary output
     *
     * @param {object} address address info {segment, module, isGroup}
     * @param {number} output output number 1-8
     * @param {boolean} isOn true/false
     */
    static buildBinary(address, output, isOn) {
        if (!output) {
            throw new Error('Invalid output number. Allowed 1-8');
        }
        return CMDS.buildAddress(
            address,
            true,
            'R8',
            '--------'.substring(0, output - 1) + (isOn ? '1' : '0') + '--------'.substring(0, 8 - output),
        );
    }

    /**
     * Control motor output
     *
     * @param {object} address address info {segment, module, isGroup}
     * @param {number | string} motor motor number 1-4
     * @param {number | string} position 0-100
     */
    static buildMotor(address, motor, position) {
        if (!motor) {
            throw new Error('Invalid motor number. Allowed 1-4');
        }
        motor = parseInt(motor.toString(), 10);
        position = parseInt(position.toString(), 10);
        if (motor === 3) {
            motor = 5;
        } else if (motor === 4) {
            motor = 6;
        }
        if (motor > 8) {
            motor = 0;
        }
        if (position > 100) {
            position = 100;
        }
        if (position < 0) {
            position = 0;
        }
        return CMDS.buildAddress(address, false, `R8M${motor}`, `GO${position}`);
    }

    static parseMotor(data) {
        // 01234567890123456789012345678901234567890123456
        // =Msssaaa.RMxpppllloooooiiiiiRMypppllloooooiiiii

        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        const m1 = parseInt(data[11], 10);
        const pos1 = parseInt(data.substring(12, 15), 10);
        const lim1 = parseInt(data.substring(15, 18), 10);
        const out1 = parseInt(data.substring(18, 23), 10);
        const in1 = parseInt(data.substring(23, 28), 10);

        const m2 = parseInt(data[30], 10);
        const pos2 = parseInt(data.substring(31, 34), 10);
        const lim2 = parseInt(data.substring(34, 37), 10);
        const out2 = parseInt(data.substring(37, 42), 10);
        const in2 = parseInt(data.substring(42, 47), 10);

        return [
            {
                segment,
                module,
                cmd: COMMANDS.MOTOR.name,
                input: m1,
                status: pos1,

                limit: lim1,
                stepOut: out1,
                stepIn: in1,
            },
            {
                segment,
                module,
                cmd: COMMANDS.MOTOR.name,
                input: m2,
                status: pos2,

                limit: lim2,
                stepOut: out2,
                stepIn: in2,
            },
        ];
    }

    /**
     * Control buttons
     *
     * @param {object} address address info {segment, module, isGroup}
     * @param {string} tableAndButton XY => X = ABCD - block name, Y = 1-8 - button number
     * @param {string|number} command 1- short, 2- long, 0- release
     */
    static buildButton(address, tableAndButton, command) {
        const table = tableAndButton[0].toUpperCase();
        const button = parseInt(tableAndButton[1], 10);
        if (!table) {
            throw new Error('Invalid table. Allowed A,B,C,D');
        }
        if (!button) {
            throw new Error('Invalid button. Allowed 1-8');
        }
        if (command === 0 || command === 'release') {
            command = 'O';
        } else if (command === 1 || command === 'short') {
            command = 'K';
        } else if (command === 2 || command === 'long') {
            command = 'L';
        }
        let abcd;
        if (table === 'A') {
            abcd = `${command}--`;
        } else if (table === 'B') {
            abcd = `-${command}-`;
        } else if (table === 'C') {
            abcd = `--${command}`;
        } else if (table === 'D') {
            abcd = `---${command}`;
        }

        return CMDS.buildAddress(
            address,
            true,
            `TS${abcd}`,
            `${'00000000'.substring(0, button - 1)}1${'00000000'.substring(0, 8 - button)}`,
        );
    }

    /**
     * Control LEDs
     *
     * @param {object} address address info {segment, module, isGroup}
     * @param {number} led 1-12
     * @param {string} isOn true/false
     */
    static buildLEDs(address, led, isOn) {
        if (!led) {
            throw new Error('Invalid LED index. Allowed 1-12');
        }

        return CMDS.buildAddress(address, true, `LA${CMDS.formatNumber(led)}`, isOn ? 'E' : 'A');
    }

    /**
     * Ask LEDs status
     *
     * @param {object} address address info {segment, module, isGroup}
     */
    static buildGetLEDs(address) {
        return CMDS.buildAddress(address, false, 'SMT');
    }
    static parseLEDs(data) {
        // 012345678901234567890123456
        // =Msssaaa.TLllllllllllllmmmm
        // =M000034.TLAAEAABFEAABANVTN

        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        const status = data.substring(11, data.length - 4);
        // const sum = data.substring(data.length - 4); // ???

        const result = [];
        for (let i = 0; i < status.length; i++) {
            result.push({
                segment,
                module,
                type: COMMANDS.LED_IN.name,
                status: status[i] !== 'A',
                input: i + 1,
            });
        }
        return result;
    }

    /**
     * Ask Name and comment
     *
     * @param {object} address address info {segment, module, isGroup}
     * @param {string} type 'name'/'comment'
     * @param {number} part 1-3
     */
    static buildGetNameComment(address, type, part) {
        return CMDS.buildAddress(address, false, 'NM', (type === 'name' ? 'N' : 'K') + part);
    }
    static parseNameComment(data) {
        // 01234567890123456789012
        // =Msssaaa.ttwwwwwwwwwwww
        // =M000034.N1comment_text

        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        const type = data[9];
        const num = data[10];
        const text = data.substring(11);

        return [
            {
                segment,
                module,
                type: COMMANDS.NAME.name,
                input: num,
                status: text.replace(/�/g, ''),
                isName: type === 'N',
            },
        ];
    }

    /**
     * Ask serial number
     *
     * @param {object} address address info {segment, module, isGroup}
     * @param {string} _type 'name'/'comment'
     * @param {number} _part 1-3
     */
    static buildGetSerial(address, _type, _part) {
        return CMDS.buildAddress(address, false, 'SN');
    }

    static parseSerial(data) {
        // 012345678901234567890123456789012345
        // =Msssaaa.SNnnnnnnnnnnttFWffffffHWhhh
        // =Msssaaa.SN17020F556601FW17020FHW008

        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        const serial = data.substring(11, 21);
        const manufacturer = parseInt(data.substring(21, 22), 10);
        const fwVersionYear = parseInt(data.substring(25, 27), 10);
        const fwVersionMonth = parseInt(data.substring(27, 29), 16);
        const fwVersionDate = parseInt(data.substring(29, 31), 16);
        const hwType = parseInt(data.substring(33), 10);

        return [
            {
                segment,
                module,
                type: COMMANDS.SERIAL.name,
                status: serial,
                serial,
                manufacturer: MANUFACTURERS[manufacturer] || manufacturer,
                hwType: HW_TYPES[hwType] || hwType,
                fwVersion: `${fwVersionYear < 50 ? 20 : 19}${fwVersionYear < 10 ? `0${fwVersionYear}` : fwVersionYear}.${fwVersionMonth < 10 ? `0${fwVersionMonth}` : fwVersionMonth}.${fwVersionDate < 10 ? `0${fwVersionDate}` : fwVersionDate}`,
            },
        ];
    }
    /**
     * Ask segment repeater
     *
     * @param {object} address address info {segment, module, isGroup}
     * @param {boolean} isAllSegments true - all segments, false only own segment
     * @param {number} groupID 3, 5-254
     */
    static buildGetSegmentRepeater(address, isAllSegments, groupID) {
        groupID = groupID || 3;

        return CMDS.buildAddress(address, false, `G${isAllSegments ? '003' : '000'}${CMDS.formatNumber(groupID)}.SK`);
    }
    static parseSegmentRepeater(data) {
        // 012345678901234567890123456789012345
        // =Msssaaa.SKnnn
        // =M022005.SK022

        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        const id = parseInt(data.substring(11, 14), 10);

        return [
            {
                segment,
                module,
                type: COMMANDS.REPEATER.name,
                status: id,
                segmentId: id,
            },
        ];
    }
    /**
     * Ask status
     *
     * @param {object} address address info {segment, module, isGroup}
     */
    static buildGetStatusAll(address) {
        return CMDS.buildAddress(address, false, 'SMM');
    }
    static buildGetStatusAnalog(address) {
        return CMDS.buildAddress(address, false, 'SMA');
    }
    static buildGetStatusRelay(address) {
        return CMDS.buildAddress(address, false, 'SMR');
    }
    static buildGetStatusSensor(address) {
        return CMDS.buildAddress(address, false, 'SMB');
    }
    static parseStatus(data) {
        data = data.replace('.', '');
        // 012345678901234567890123456789012345
        // :MsssaaaAnddd
        // :MsssaaaRxrrrrrrrr
        // :MsssaaaBxrrrrrrrr
        // :MsssaaaSdrrr
        // :M000007Rx000

        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        const type = data[8];
        if (type === 'A') {
            const input = parseInt(data[9], 10);
            const status = parseInt(data.substring(10), 10);
            return [
                {
                    segment,
                    module,
                    type: COMMANDS.ANALOG_IN.name,
                    status,
                    input,
                },
            ];
        } else if (type === 'R') {
            const status = parseInt(data.substring(10), 10);
            const result = [];
            for (let i = 0; i < 8; i++) {
                result.push({
                    segment,
                    module,
                    type: COMMANDS.RELAY_IN.name,
                    status: !!(status & (1 << i)),
                    input: i + 1,
                });
            }
            return result;
        } else if (type === 'B') {
            const status = parseInt(data.substring(10), 10);
            const result = [];
            for (let i = 0; i < 8; i++) {
                result.push({
                    segment,
                    module,
                    type: COMMANDS.SENSOR_IN.name,
                    status: !!(status & (1 << i)),
                    input: i + 1,
                });
            }
            return result;
        } else if (type === 'S') {
            const input = data.substring(9);
            const status = parseInt(data.substring(10), 10);
            return [
                {
                    segment,
                    module,
                    type: COMMANDS.SUM.name,
                    status,
                    input,
                },
            ];
        }
    }

    static buildGetBinaryStatus(address) {
        return CMDS.buildAddress(address, false, 'SMB');
    }

    static buildGetVariables(address) {
        const input = address.input;
        delete address.input;
        return CMDS.buildAddress(address, false, `MWT${input}`);
    }
    static buildGetCounters(address) {
        const input = address.input;
        delete address.input;
        return CMDS.buildAddress(address, false, `MWC${input}`);
    }
    static buildGetSetValues(address) {
        const input = address.input;
        delete address.input;
        return CMDS.buildAddress(address, false, `MWS${input}`);
    }
    static buildGetLimits(address) {
        const input = address.input;
        delete address.input;
        return CMDS.buildAddress(address, false, `SE${input}`);
    }
    static buildSetRegulator(address, output, level) {
        delete address.input;
        level = 1000 + level * 10;
        return CMDS.buildAddress(
            address,
            false,
            `RE${output === 1 ? 'A' : 'B'}SSE${parseInt(level, 10).toString().padStart(5, '0')}`,
        );
    }
    static buildSetRegulatorLock(address, output, lock) {
        delete address.input;
        return CMDS.buildAddress(address, false, `RE${output === 1 ? 'A' : 'B'}X${lock ? 'S' : 'A'}`);
    }
    static buildSetDisplay(address, line, part, text) {
        delete address.input;
        return CMDS.buildAddress(address, false, `GTDT${line}${part}`, text);
    }
    static parseLimits(data) {
        // 012345678901234567890123456789012345
        // %M000111.T2401200
        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        const input = parseInt(data[10], 10); // register
        const limitNum = parseInt(data[11], 10); // limit number
        const status = parseInt(data.substring(12), 10);
        return [
            {
                segment,
                module,
                type: COMMANDS.LIMIT.name,
                status,
                input,
                limit: limitNum,
            },
        ];
    }

    static parseVariables(data) {
        // 012345678901234567890123456789012345
        // %Msssaaa.Annnvvvvv
        // %Msssaaa.Cnnnvvvvv
        // %Msssaaa.vvvvv

        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        const type = data[9];
        if (type === 'A') {
            // variables
            const input = parseInt(data.substring(10, 13), 10);
            let status = parseInt(data.substring(13), 10);

            if (input === 2 || input === 3) {
                status = (status - 1000) / 10;
            }

            return [
                {
                    segment,
                    module,
                    type: COMMANDS.VAR.name,
                    status,
                    input,
                },
            ];
        } else if (type === 'C') {
            // Counter
            const input = parseInt(data.substring(10, 13), 10);
            const status = parseInt(data.substring(13), 10);
            return [
                {
                    segment,
                    module,
                    type: COMMANDS.COUNTER.name,
                    status,
                    input,
                },
            ];
        } else if (type >= '0' && type <= '9') {
            // measure value
            const value = parseInt(data.substring(9), 10);
            return [
                {
                    segment,
                    module,
                    type: COMMANDS.MEASURE.name,
                    value,
                },
            ];
        }
        console.log(`Unknown frame: ${data}`);
    }

    static parseSetValue(data) {
        // 012345678901234567890123456789012345
        // %Msssaaa.Scnnnnn
        // %M000111.S101200

        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        const input = data[10];
        let status = parseInt(data.substring(11), 10);
        let lock = !!(status & 0x8000);
        status = status & 0x7fff;
        status = (status - 1000) / 10;
        return [
            {
                segment,
                module,
                type: COMMANDS.REGULATOR_OUT.name,
                status,
                input,
            },
            {
                segment,
                module,
                type: COMMANDS.REGULATOR_LOCK_OUT.name,
                status: lock,
                input,
            },
        ];
    }

    static parseLockValue(data) {
        // 012345678901234567890123456789012345
        // %Msssaaa.Scnnnnn
        // %M000111.S101200

        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        const input = data[10];
        let status = !!(parseInt(data.substring(11), 10) & 0x8000);
        return [
            {
                segment,
                module,
                type: COMMANDS.REGULATOR.name,
                status,
                input,
            },
        ];
    }

    static parseIR(data) {
        data = data.replace('.', '');
        // 01234567890123456789012345
        // =Msssaaa.ZImmmnnnoookkkaaa
        // =Msssaaa.ZI017034051013002

        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        return [
            {
                segment,
                module,
                type: COMMANDS.IR.name,
                serial: data.substring(11, 20),
                level: parseInt(data[21], 10) + 1,
                key: parseInt(data[22], 10),
                lowBat: data[24] === '1',
                action: data[25] === '1' ? 1 : data[25] === '2' ? 2 : 0,
            },
        ];
    }

    static parseFingerSensor(data) {
        data = data.replace('.', '');
        // 01234567890123456789012345
        // =Msssaaa.ZTmmmnnnooo
        // =Msssaaa.ZT017034

        const segment = parseInt(data.substring(2, 5), 10);
        const module = parseInt(data.substring(5, 8), 10);

        return [
            {
                segment,
                module,
                type: COMMANDS.IR.name,
                serial: data.substring(11, 20),
            },
        ];
    }
}

CMDS.analogMode = ANALOG_MODES.DEFAULT;

const COMMANDS = {
    ANALOG_OUT: { name: 'ANALOG', generate: CMDS.buildAnalog, detect: detectAck, parse: CMDS.parseAck },
    ANALOG_IN: { name: 'ANALOG', generate: CMDS.buildAnalog, detect: detectAck, parse: CMDS.parseAck },
    SENSOR_IN: { name: 'SENSOR', generate: null, detect: detectAck, parse: CMDS.parseStatus },
    RELAY_OUT: { name: 'RELAY_OUT', generate: CMDS.buildBinary, detect: detectAck, parse: CMDS.parseAck },
    RELAY_IN: { name: 'RELAY', generate: CMDS.buildGetBinaryStatus, detect: detectAck, parse: CMDS.parseStatus },
    REGULATOR_OUT: {
        name: 'REGULATOR_OUT',
        generate: CMDS.buildSetRegulator,
        detect: detectGetSetValues,
        parse: CMDS.parseSetValue,
    },
    REGULATOR: {
        name: 'REGULATOR',
        generate: CMDS.buildGetSetValues,
        detect: detectGetSetValues,
        parse: CMDS.parseSetValue,
    },
    REGULATOR_LOCK_OUT: {
        name: 'REGULATOR_LOCK_OUT',
        generate: CMDS.buildSetRegulatorLock,
        detect: detectGetSetValues,
        parse: CMDS.parseSetValue,
    },
    DISPLAY_OUT: { name: 'DISPLAY_OUT', generate: CMDS.buildSetDisplay, detect: detectAck, parse: CMDS.parseAck },
    MOTOR: { name: 'MOTOR', generate: CMDS.buildMotor, detect: detectMotor, parse: CMDS.parseMotor },
    BUTTON: { name: 'BUTTON', generate: CMDS.buildButton, detect: detectAck, parse: CMDS.parseAck },
    LED_OUT: { name: 'LED', generate: CMDS.buildLEDs, detect: detectAck, parse: CMDS.parseAck },
    LED_IN: { name: 'LED', generate: CMDS.buildGetLEDs, detect: detectLEDs, parse: CMDS.parseLEDs },
    NAME: { name: 'NAME', generate: CMDS.buildGetNameComment, detect: detectNameComment, parse: CMDS.parseNameComment },
    SERIAL: { name: 'SERIAL', generate: CMDS.buildGetSerial, detect: detectSerial, parse: CMDS.parseSerial },
    REPEATER: {
        name: 'REPEATER',
        generate: CMDS.buildGetSegmentRepeater,
        detect: detectSegmentRepeater,
        parse: CMDS.parseSegmentRepeater,
    },
    STATUS_ALL: { name: 'STATUS', generate: CMDS.buildGetStatusAll, detect: detectStatus, parse: CMDS.parseStatus },
    STATUS_R: { name: 'STATUS', generate: CMDS.buildGetStatusRelay, detect: detectStatus, parse: CMDS.parseStatus },
    STATUS_S: { name: 'STATUS', generate: CMDS.buildGetStatusSensor, detect: detectStatus, parse: CMDS.parseStatus },
    STATUS_A: { name: 'STATUS', generate: CMDS.buildGetStatusAnalog, detect: detectStatus, parse: CMDS.parseStatus },
    VAR: { name: 'VAR', generate: CMDS.buildGetVariables, detect: detectVariables, parse: CMDS.parseVariables },
    COUNTER: { name: 'COUNTER', generate: CMDS.buildGetCounters, detect: detectCounters, parse: CMDS.parseVariables },
    MEASURE: { name: 'MEASURE', generate: null, detect: detectMeasure, parse: CMDS.parseVariables },
    SUM: { name: 'SUM', generate: null, detect: detectSum, parse: CMDS.parseStatus },
    IR: { name: 'IR', generate: null, detect: detectIR, parse: CMDS.parseIR },
    FINGER_SCAN: { name: 'FINGER', generate: null, detect: detectFingerSensor, parse: CMDS.parseFingerSensor },
    LIMIT: { name: 'LIMIT', generate: CMDS.buildGetLimits, detect: detectLimits, parse: CMDS.parseLimits },
};

module.exports = {
    CMDS,
    ACK_ERRORS,
    COMMANDS,
};
