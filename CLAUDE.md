# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`iobroker.lcn` is an ioBroker adapter for the **LCN (Local Control Network)** bus. It connects via TCP to an LCN-PCHK (or LCN-PKE / LCN-VISU) gateway, speaks the text based **PCK protocol**, scans the bus for modules and creates one ioBroker device per module (`lcn.0.S000.M010`) with channels for analog outputs, relays, sensors, LEDs, variables, counters, thresholds, regulators, display lines and buttons.

TypeScript (CommonJS output). Sources live in `src/`, the published/runnable code is the compiled `build/` (`package.json` `main` is `build/main.js`). `build/` is gitignored — always run the build before starting the adapter or the tests.

## Commands

```bash
npm run build                             # tsc -p tsconfig.build.json  -> build/
npm run watch                             # same in watch mode
npm run check                             # type check only (tsconfig.json, noEmit)
npm run lint                              # eslint (@iobroker/eslint-config, flat config)
npx eslint -c eslint.config.mjs --fix src # autofix + prettier formatting

npm run test:unit                         # mocha test/unit - needs `npm run build` first (tests require build/)
npm run test:package                      # validates package.json / io-package.json / jsonConfig (downloads schemas, retry on ECONNRESET)
npm run test:integration                  # starts a real js-controller + adapter instance
npm run release-patch                     # @alcalzone/release-script, moves README changelog into io-package news
```

There is deliberately **no `prepare` script** — `npm ci`/`npm install` does not build. Because `build/` is neither committed nor built on install, `common.nogit` is `true` in `io-package.json`: the adapter can only be installed from npm, not from GitHub. The integration test requires that **no** js-controller is running on the machine, otherwise it aborts with "JS-Controller is already running!".

`test/unit/lcn.test.js` runs the LCN library against a small simulated PCHK (TCP server on a random port): login, analog/decimal mode, scan of one module, relay command, status update and `destroy`. Extend the `answer()` table there when testing new commands.

## Architecture

### Layout

| Path | Content |
| --- | --- |
| `src/main.ts` | the adapter: one `LcnAdapter extends utils.Adapter` class, creates the ioBroker objects |
| `src/lib/lcn.ts` | `LCN` - bus logic: dispatches received lines, scan (`scanSegment`), status read (`scanModules`), `control`, `read` |
| `src/lib/connection.ts` | `Connection` - TCP socket, PCHK login state machine, command queue, ping, reconnect |
| `src/lib/cmds.ts` | `CMDS` (PCK command builders and parsers) and `COMMANDS` (name / generate / detect / parse per command) |
| `src/lib/DeviceManagement.ts` | device manager (`@iobroker/dm-utils`) shown in the "Modules" tab |
| `src/lib/i18n.ts` | `t(key, ...args)` - device manager texts, read from `admin/i18n/*.json` at runtime |
| `src/lib/analogModes.ts` | the 4 analog modes (`!OM0P`, `!OM0N`, `!OM1P`, `!OM1N`) |
| `src/lib/types.ts` | `LcnState` (one parsed answer), `FoundModule`, `LcnDeviceNative`, options |
| `src/lib/adapter-config.d.ts` | augments `ioBroker.AdapterConfig` |
| `admin/jsonConfig.json` | the configuration dialog (tabs: main, advanced, modules = device manager) |
| `admin/icons/<hwType>.png` | module pictures, referenced by `common.icon` of the device objects |

`src/lib/adapter-config.d.ts` is hand-maintained and must be kept in sync with `native` in `io-package.json` **and** with `admin/jsonConfig.json` — nothing generates it.

### PCK protocol in short

- Lines end with `\n`. Commands to a module: `>M<seg:3><mod:3>.<cmd>` (`!` instead of `.` requests an acknowledge, answered with `-M<seg><mod>!` or an error code).
- Answers/updates start with `=M` (name, serial, LEDs), `:M` (status of outputs/relays/sensors/logic operations) or `%M` (variables, counters, thresholds, set values).
- Every `COMMANDS` entry has a `detect` RegExp. `LCN` tests every received line against all `detect`s in definition order — the **first** match wins, so the order of `COMMANDS` matters (e.g. every acknowledge is parsed by `ANALOG_OUT`, the first entry with `detectAck`).
- `COMMANDS[x].name` (e.g. `ANALOG`, `RELAY`, `LED`) is used for object IDs and `native.command`. Several keys share a name (`ANALOG_IN`/`ANALOG_OUT`, `LED_IN`/`LED_OUT`). `LCN.control()` looks the generator up by `COMMANDS[name] || COMMANDS[name + '_OUT']`.
- Logic operations (SUM): `:MsssaaaSdrrr`, `d` = operation 1-4 → `SUMS.SUM01`…`SUMS.SUM04`.

### Connection (`src/lib/connection.ts`)

State machine `CONNECTING → WAIT_PROMPT (LCN-PCK/IP) → WAIT_USER → WAIT_PASS → WAIT_AUTH_OK → WAIT_CONNECTED ($io:#LCN:connected) → READY`. After connect it sets the analog mode and the decimal mode (`!CHD`), then emits `connected`.

- Commands are **strictly serialized**: one command is in flight (`WAIT_RESPONSE`), it waits for its `regAnswer` or times out. Lines that do not answer the current command are emitted as `data`.
- `ignoreTimeoutError` resolves with `undefined` instead of rejecting — used by the scan for optional answers.
- Ping (`^ping<n>`) every `pingInterval`; a missing/mismatched answer reconnects.
- `destroy(isReconnect, cb)`: with `isReconnect` it schedules a reconnect after `reconnectTimeout`.
- The library uses its **own timers** (not `this.setTimeout` of the adapter) so it stays usable without an adapter; `destroy()` clears all of them.

### Scan (`LCN.scanSegment`)

1. `SCANNING`: for every address `min..max` request the name (`NMN1`), timeout = `scanResponseTimeout`.
2. `READING`: for every found module read name part 2, comment 1-3, serial, VAR1-12, REGULATOR 1-2, LEDs and then either relays+analogs (module has LEDs) or the full status. Answers that arrive while a module is being read are collected in `found[module].states` instead of being emitted as `update`.
3. Progress is emitted as `scan` events → states `scan.step/progress/found` and the progress dialog of the device manager.

`LcnAdapter.processFoundDevices()` then creates/updates the objects (`createModuleObjects()`).

One scan covers one segment. Segment `0` is the own segment (that is what goes over the wire, PCHK answers with `000` too), other segments are addressed by their segment ID. The device manager takes a list of segments (`parseSegments()`) and calls `scanRange(range, segment)` for each one after another; "Scan again" uses the segment of the module. There is no automatic detection of segment couplers: `COMMANDS.REPEATER` exists but its generator (`>M….G003003.SK`) and its detect (`=G…`) do not match the PCK format (`>G003003.SK` → `=Msssaaa.SKnnn`) and it is untested without hardware.

### Objects

- Device `S<seg:3>.M<mod:3>`, `native` = `LcnDeviceNative` (segment, module, serial, hwType, counts of detected states, and the user settings `relaysOut`, `display`, `regulator`).
- States `S000.M010.<NAME>S.<NAME><nn>` (e.g. `ANALOGS.ANALOG01`, `RELAYS.RELAY03`, `VARS.VAR12`, `LIMITS.LIMIT01_02`, `BUTTONS_A.BUTTON_A01`). `native` = `{ segment, module, command, output }` — `onStateChange` sends `LCN.control(segment, module, command, output, val)`.
- Updates for states that do not exist yet are created on the fly (`createStateOnTheFly()`). The generated ID **must** equal the requested one, otherwise `updateVariable` would recurse endlessly (#119).
- `recalculateRelays()` creates/deletes the states that cannot be detected: output relays, display lines, regulator outputs/locks. It runs on start and (debounced 1 s) on every device object change — so changing the device `native` is how the device manager applies the module settings.
- `combinedRelays`: input and output relay are the same state (`RELAYS.RELAYnn` with `native.command = RELAY_OUT`).
- VAR conversion depends on the **role** the user sets on the state (`value.temperature`, `value.brightness`, ...), see `updateVariable()`.

### Messages

`onMessage` handles `scan`/`scanOne` (`{ max: "250" | "5-30" }`) and `getAll` — documented API, do not rename. `dm:*` commands are handled by `@iobroker/dm-utils` itself (it registers its own `message` listener).

### Known quirks kept on purpose

Marked with `(sic)` in the code. They were kept when the code was translated to TypeScript, so the behavior did not change. Fix them in separate commits and mention them in the changelog. Still open:

- `LCN.read(..., 'SE')` uses `COMMANDS.SETTING`, which does not exist. It cannot be reached, because the regex of `scan.manual` captures only one character for the operation.
- `connection.commandPromise()` rejects with plain strings (`'timeout'`), callers compare them.
- IR / finger sensor: `serial` is `substring(11, 20)` after the dot was removed. That looks off by one compared to the format comment, but it is not verified with real data. Do not change it without a log from a real installation.

### Misc conventions

- Always use `this.setTimeout` / `this.clearTimeout` in `main.ts`, never the globals.
- `__dirname` is `build/lib` at runtime: assets are resolved with `join(__dirname, '..', '..', 'admin', ...)`.
- Translations: flat `admin/i18n/<lang>.json`, keys are the English texts. The same files are used by jsonConfig (`"i18n": true`) and by the device manager (`src/lib/i18n.ts`). Add new device manager texts there in all 11 languages.
- The password is stored via `encryptedNative`/`protectedNative` in `io-package.json`, so the jsonConfig field has no `"encrypted"` flag.

## Release flow

Changelog lives in `README.md` under the `### **WORK IN PROGRESS**` heading; `release-script` (config in `.releaseconfig.json`) moves it into `io-package.json` `common.news`. CI (`.github/workflows/test-and-release.yml`) type-checks, lints, runs `test:package`, then builds and runs `test:unit` + `test:integration` on Node 22/24/26 × Linux/Windows/macOS, and publishes to npm (trusted publishing) on version tags.
