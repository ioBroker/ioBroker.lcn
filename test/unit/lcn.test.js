const assert = require('node:assert');
const net = require('node:net');
const { LCN, SCAN_STEP } = require('../../build/lib/lcn');

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Minimal simulation of LCN-PCHK with one module (segment 0, module 7)
 *
 * @returns {Promise<{server: net.Server, port: number, received: string[], connections: number, push: (line: string) => void}>}
 */
function startPchk() {
    return new Promise(resolve => {
        const sim = { received: [], connections: 0, sockets: [] };
        sim.push = line => sim.sockets.forEach(s => s.write(`${line}\n`));

        const answer = line => {
            switch (line) {
                case 'u':
                    return ['Password:'];
                case 'p':
                    return ['OK', '$io:#LCN:connected'];
                case '!OM0P':
                    return ['(0..50-mode percent)'];
                case '!CHD':
                    return ['(dec-mode)'];
                case '>M000007.NMN1':
                    return ['=M000007.N1Kitchen'];
                case '>M000007.NMN2':
                    return ['=M000007.N2 main'];
                case '>M000007.NMK1':
                    return ['=M000007.K1Comment'];
                case '>M000007.SN':
                    return ['=M000007.SN17020F556601FW17020FHW008'];
                case '>M000007.SMT':
                    return ['=M000007.TLAAEAABFEAABANVTN'];
                case '>M000007.SMA':
                    return [':M000007A1050'];
                case '>M000007!R8-1------':
                    return ['-M000007!'];
            }
            const m = line.match(/^>M000007\.MWT(\d+)$/);
            if (m) {
                return [`%M000007.A${m[1].padStart(3, '0')}00500`];
            }
            // Everything else (other modules, regulators, ...) is not answered
            return [];
        };

        const server = net.createServer(socket => {
            sim.connections++;
            sim.sockets.push(socket);
            socket.on('error', () => {});
            socket.write('LCN-PCK/IP 1.0\nUsername:\n');
            let buffer = '';
            socket.on('data', data => {
                buffer += data.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines.map(l => l.trim()).filter(l => l)) {
                    sim.received.push(line);
                    answer(line).forEach(a => socket.write(`${a}\n`));
                }
            });
        });
        server.listen(0, '127.0.0.1', () => {
            sim.server = server;
            sim.port = server.address().port;
            resolve(sim);
        });
    });
}

describe('LCN library with simulated PCHK', function () {
    this.timeout(20000);

    let sim;
    let lcn;

    before(async () => {
        sim = await startPchk();
        lcn = new LCN({
            host: '127.0.0.1',
            port: sim.port,
            user: 'u',
            password: 'p',
            reconnectTimeout: 100,
            connectTimeout: 2000,
            defaultTimeout: 500,
            pingInterval: 600000,
            pingTimeout: 500,
            scanResponseTimeout: 100,
            logger: silentLogger,
        });
        await new Promise(resolve => lcn.once('connected', resolve));
    });

    after(() => {
        sim.sockets.forEach(s => s.destroy());
        sim.server.close();
    });

    it('should log in and set the analog and decimal mode', () => {
        assert.ok(lcn.isConnected());
        assert.deepStrictEqual(sim.received.slice(0, 4), ['u', 'p', '!OM0P', '!CHD']);
    });

    it('should scan a module', async () => {
        const steps = [];
        const onScan = step => steps.push(step.step);
        lcn.on('scan', onScan);
        const found = await lcn.scanSegment(6, 8);
        lcn.off('scan', onScan);

        assert.deepStrictEqual(Object.keys(found), ['7']);
        const module = found[7];
        assert.strictEqual(module.name, 'Kitchen main');
        assert.strictEqual(module.comment, 'Comment');
        assert.strictEqual(module.serial, '17020F5566');
        assert.strictEqual(module.segment, 0);
        assert.strictEqual(module.module, 7);
        const vars = module.states.filter(s => s.type === 'VAR');
        assert.strictEqual(vars.length, 12, 'all 12 variables are collected');
        assert.ok(module.states.find(s => s.type === 'LED'), 'LEDs are collected');
        assert.ok(module.states.find(s => s.type === 'ANALOG' && s.input === 1 && s.status === 50), 'analog');
        assert.ok(steps.includes(SCAN_STEP.SCANNING));
        assert.ok(steps.includes(SCAN_STEP.READING));
        assert.strictEqual(steps[steps.length - 1], SCAN_STEP.INACTIVE);
    });

    it('should control a relay', async () => {
        const answer = await lcn.control(0, 7, 'RELAY_OUT', 2, true);
        assert.strictEqual(answer, '-M000007!');
    });

    it('should emit status updates', async () => {
        const update = new Promise(resolve => lcn.once('update', resolve));
        sim.push(':M000007A2050');
        assert.deepStrictEqual(await update, { segment: 0, module: 7, type: 'ANALOG', status: 50, input: 2 });
    });

    it('should call the callback of destroy and not reconnect', async () => {
        const connections = sim.connections;
        await new Promise(resolve => lcn.destroy(resolve));
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.strictEqual(sim.connections, connections);
    });
});
