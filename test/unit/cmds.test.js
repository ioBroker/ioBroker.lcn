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
