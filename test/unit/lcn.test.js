const assert = require('node:assert');
const net = require('node:net');
const { LCN, SCAN_STEP } = require('../../build/lib/lcn');
const { Connection } = require('../../build/lib/connection');

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Minimal simulation of LCN-PCHK with module 7 in the own segment (0) and in segment 5
 *
 * @returns {Promise<{server: net.Server, port: number, received: string[], connections: number, push: (line: string) => void}>}
 */
function startPchk(options = {}) {
    return new Promise(resolve => {
        const sim = { received: [], connections: 0, sockets: [] };
        sim.push = line => sim.sockets.forEach(s => s.write(`${line}\n`));

        const answer = line => {
            switch (line) {
                case 'u':
                    return ['Password:'];
                case 'p':
                    return options.authFailed ? ['Authentification failed.'] : ['OK', '$io:#LCN:connected'];
                case '!OM0P':
                    return ['(0..50-mode percent)'];
                case '!CHD':
                    return ['(dec-mode)'];
                case '>M000007!R8-1------':
                    return ['-M000007!'];
            }
            // module 7 exists in the own segment (0) and in segment 5
            const m = line.match(/^>M(000|005)007\.(.+)$/);
            if (!m) {
                // Everything else (other modules, ...) is not answered
                return [];
            }
            const addr = `M${m[1]}007`;
            const name = m[1] === '000' ? 'Kitchen' : 'Garage';
            const variable = m[2].match(/^MWT(\d+)$/);
            if (variable) {
                return [`%${addr}.A${variable[1].padStart(3, '0')}00500`];
            }
            switch (m[2]) {
                case 'NMN1':
                    return [`=${addr}.N1${name}`];
                case 'NMN2':
                    return [`=${addr}.N2 main`];
                case 'NMK1':
                    return [`=${addr}.K1Comment`];
                case 'SN':
                    return [`=${addr}.SN17020F556601FW17020FHW008`];
                case 'SMT':
                    return [`=${addr}.TLAAEAABFEAABANVTN`];
                case 'SMA':
                    return [`:${addr}A1050`];
            }
            // regulators, comments 2 and 3, ... are not answered
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

    it('should scan a module in another segment', async () => {
        const found = await lcn.scanSegment(6, 8, 5);
        assert.deepStrictEqual(Object.keys(found), ['7']);
        assert.strictEqual(found[7].name, 'Garage main');
        assert.strictEqual(found[7].segment, 5);
        assert.strictEqual(found[7].module, 7);
        assert.strictEqual(found[7].states.filter(s => s.type === 'VAR').length, 12, 'all 12 variables are collected');
        assert.ok(found[7].states.every(state => state.segment === 5));
        assert.ok(sim.received.includes('>M005007.NMN1'));
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

describe('Connection with simulated PCHK', function () {
    this.timeout(10000);

    const params = port => ({
        host: '127.0.0.1',
        port,
        user: 'u',
        password: 'p',
        reconnectTimeout: 100,
        connectTimeout: 2000,
        pingInterval: 600000,
        pingTimeout: 500,
        logger: silentLogger,
    });

    it('should detect a failed authentication', async () => {
        const sim = await startPchk({ authFailed: true });
        const conn = new Connection(params(sim.port));
        const error = await new Promise(resolve => conn.on('error', resolve));
        await new Promise(resolve => conn.destroy(false, resolve));
        sim.sockets.forEach(s => s.destroy());
        sim.server.close();
        assert.strictEqual(error, 'Authentication failure');
    });

    it('should send all commands without callback, that wait behind a command with callback', async () => {
        const sim = await startPchk();
        const conn = new Connection(params(sim.port));
        await new Promise(resolve => conn.once('connected', resolve));
        // This command is never answered, the commands behind it wait till its timeout
        const pending = conn.commandPromise('>M000099.NMN1', /^never$/, 300, true);
        conn.command('>M000099.A');
        conn.command('>M000099.B');
        conn.command('>M000099.C');
        await pending;
        await new Promise(resolve => setTimeout(resolve, 200));
        await new Promise(resolve => conn.destroy(false, resolve));
        sim.sockets.forEach(s => s.destroy());
        sim.server.close();
        // Before 4.0.0 only ">M000099.A" was sent
        assert.deepStrictEqual(
            sim.received.filter(line => line.startsWith('>M000099')),
            ['>M000099.NMN1', '>M000099.A', '>M000099.B', '>M000099.C'],
        );
    });

    it('should log in again after the connection was closed', async () => {
        const sim = await startPchk();
        const conn = new Connection(params(sim.port));
        await new Promise(resolve => conn.once('connected', resolve));
        // the gateway drops the connection
        sim.sockets.forEach(s => s.destroy());
        await new Promise(resolve => conn.once('connected', resolve));
        await new Promise(resolve => conn.destroy(false, resolve));
        sim.sockets.forEach(s => s.destroy());
        sim.server.close();
        assert.strictEqual(sim.connections, 2);
        // logged in twice
        assert.deepStrictEqual(sim.received.filter(line => line === 'u').length, 2);
    });
});
