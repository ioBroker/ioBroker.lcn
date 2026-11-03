const assert = require('node:assert');
const { CMDS, COMMANDS } = require('../../build/lib/cmds');

describe('CMDS.parseStatus', () => {
    it('should parse status of logic operations (SUM)', () => {
        assert.match(':M000015S1025', COMMANDS.SUM.detect);
        assert.deepStrictEqual(CMDS.parseStatus(':M000015S1025'), [
            { segment: 0, module: 15, type: COMMANDS.SUM.name, status: 25, input: 1 },
        ]);
        assert.deepStrictEqual(CMDS.parseStatus(':M000180S4050'), [
            { segment: 0, module: 180, type: COMMANDS.SUM.name, status: 50, input: 4 },
        ]);
        assert.deepStrictEqual(CMDS.parseStatus(':M000014S2000'), [
            { segment: 0, module: 14, type: COMMANDS.SUM.name, status: 0, input: 2 },
        ]);
    });

    it('should parse analog status', () => {
        assert.deepStrictEqual(CMDS.parseStatus(':M000007A2050'), [
            { segment: 0, module: 7, type: COMMANDS.ANALOG_IN.name, status: 50, input: 2 },
        ]);
    });

    it('should parse relay status', () => {
        const result = CMDS.parseStatus(':M000023Rx128');
        assert.strictEqual(result.length, 8);
        assert.deepStrictEqual(
            result.map(r => r.status),
            [false, false, false, false, false, false, false, true],
        );
        assert.strictEqual(result[7].input, 8);
        assert.strictEqual(result[7].type, COMMANDS.RELAY_IN.name);
    });
});

describe('CMDS IR and finger sensor', () => {
    it('should deliver the low battery flag of IR remote controls', () => {
        const [ir] = CMDS.parseIR('=M000005.ZI0170340510130021');
        assert.strictEqual(ir.type, COMMANDS.IR.name);
        assert.strictEqual(typeof ir.lowBat, 'boolean');
    });

    it('should deliver the type FINGER for finger sensors', () => {
        assert.match('=M000005.ZT017034051', COMMANDS.FINGER_SCAN.detect);
        const [finger] = CMDS.parseFingerSensor('=M000005.ZT017034051');
        assert.strictEqual(finger.type, COMMANDS.FINGER_SCAN.name);
        assert.strictEqual(finger.module, 5);
    });
});

describe('CMDS firmware before 170206', () => {
    const { FIRMWARE_TYPED_VARIABLES } = require('../../build/lib/cmds');

    it('should deliver the firmware as number', () => {
        const [newModule] = CMDS.parseSerial('=M000007.SN17020F556601FW17020FHW008');
        assert.strictEqual(newModule.fwSerial, 0x17020f);
        assert.ok(newModule.fwSerial >= FIRMWARE_TYPED_VARIABLES);
        const [oldModule] = CMDS.parseSerial('=M000020.SN0C0A0F1A2B01FW0C0A0FHW004');
        assert.strictEqual(oldModule.fwSerial, 0x0c0a0f);
        assert.ok(oldModule.fwSerial < FIRMWARE_TYPED_VARIABLES);
    });

    it('should build the requests of the variables and set values', () => {
        const address = { segment: 0, module: 20 };
        assert.strictEqual(CMDS.buildGetVariableTypeless({ ...address }, 1), '>M000020.MWV');
        assert.strictEqual(CMDS.buildGetVariableTypeless({ ...address }, 2), '>M000020.MWTA');
        assert.strictEqual(CMDS.buildGetVariableTypeless({ ...address }, 3), '>M000020.MWTB');
        assert.throws(() => CMDS.buildGetVariableTypeless({ ...address }, 4));
        assert.strictEqual(CMDS.buildGetSetValueTypeless({ ...address }, 1), '>M000020.MWSA');
        assert.strictEqual(CMDS.buildGetSetValueTypeless({ ...address }, 2), '>M000020.MWSB');
    });

    it('should detect only typeless answers of the requested module', () => {
        const detect = CMDS.detectTypeless(0, 20);
        assert.match('%M000020.01205', detect);
        assert.doesNotMatch('%M000021.01205', detect);
        assert.doesNotMatch('%M000020.A00101205', detect);
        assert.doesNotMatch('%M000020.S101205', detect);
        assert.match('%M000020.A00301205', CMDS.detectVariable(0, 20, 3));
        assert.doesNotMatch('%M000020.A00401205', CMDS.detectVariable(0, 20, 3));
    });

    it('should assign the typeless answer to the requested variable', () => {
        // the same conversion as for modules with newer firmware
        assert.deepStrictEqual(CMDS.parseTypelessVariable('%M000020.01205', 1), [
            ...CMDS.parseVariables('%M000020.A00101205'),
        ]);
        assert.deepStrictEqual(CMDS.parseTypelessVariable('%M000020.01180', 2), [
            { segment: 0, module: 20, type: COMMANDS.VAR.name, status: 1180, input: 2 },
        ]);
        assert.deepStrictEqual(CMDS.parseTypelessSetValue('%M000020.33978', 2), [
            { segment: 0, module: 20, type: COMMANDS.REGULATOR_OUT.name, status: 21, input: '2' },
            { segment: 0, module: 20, type: COMMANDS.REGULATOR_LOCK_OUT.name, status: true, input: '2' },
        ]);
    });
});

describe('Conversion of variables', () => {
    const { convertVariable } = require('../../build/lib/variables');

    it('should deliver raw values from the parser', () => {
        assert.deepStrictEqual(CMDS.parseVariables('%M000007.A00201180'), [
            { segment: 0, module: 7, type: COMMANDS.VAR.name, status: 1180, input: 2 },
        ]);
    });

    it('should convert VAR02 and VAR03 only once', () => {
        // Before 4.0.0 the parser converted VAR02/VAR03 and the role converted them again: (18 - 1000) / 10
        assert.deepStrictEqual(convertVariable(1180, 'value.temperature', 2), { value: 18, unit: '°C' });
        assert.deepStrictEqual(convertVariable(1190, 'value.temperature', 3), { value: 19, unit: '°C' });
        // without a special role they are still shown in °C, as before
        assert.deepStrictEqual(convertVariable(1180, 'value', 2), { value: 18 });
        assert.deepStrictEqual(convertVariable(1190, undefined, 3), { value: 19 });
        // other roles get the raw value
        assert.deepStrictEqual(convertVariable(123, 'value.speed.wind', 2), { value: 12.3, unit: 'm/s' });
    });

    it('should convert the other variables by their role', () => {
        assert.deepStrictEqual(convertVariable(1205, 'value', 1), { value: 1205 });
        assert.deepStrictEqual(convertVariable(1205, 'value.temperature', 1), { value: 20.5, unit: '°C' });
        assert.deepStrictEqual(convertVariable(500, 'value.brightness', 5), {
            value: Math.round(Math.exp(5) * 10) / 10,
            unit: 'lux',
        });
        assert.deepStrictEqual(convertVariable(4000, 'value.voltage', 6), { value: 10, unit: 'V' });
        assert.deepStrictEqual(convertVariable(1050, 'value.current', 7), { value: 5, unit: 'A' });
        assert.deepStrictEqual(convertVariable(2800, 'value.sun.azimuth', 8), { value: 180, unit: '°' });
        assert.deepStrictEqual(convertVariable(1450, 'value.sun.elevation', 9), { value: 45, unit: '°' });
    });
});

describe('Device manager helpers', () => {
    const { parseSegments } = require('../../build/lib/DeviceManagement');

    it('should parse a list of segments', () => {
        assert.deepStrictEqual(parseSegments(''), [0]);
        assert.deepStrictEqual(parseSegments('0'), [0]);
        assert.deepStrictEqual(parseSegments('0, 5,7; 7 12'), [0, 5, 7, 12]);
        assert.strictEqual(parseSegments('5-7'), null);
        assert.strictEqual(parseSegments('256'), null);
        assert.strictEqual(parseSegments('a'), null);
    });
});
