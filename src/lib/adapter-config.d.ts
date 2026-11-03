// Augments the globally declared ioBroker types with everything this adapter adds.
// Keep in sync with `native` in io-package.json and with admin/jsonConfig.json.
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** IP address of the LCN-PCHK, LCN-VISU or LCN-PKE */
            host: string;
            /** TCP port of the PCK protocol, default 4114 */
            port: number;
            /** 1-4, see ANALOG_MODES */
            analogMode: number;
            /** In seconds in the config, converted to ms on start */
            reconnectTimeout: number;
            /** In ms */
            connectTimeout: number;
            /** Response timeout in ms */
            defaultTimeout: number;
            /** In seconds in the config, converted to ms on start */
            pingInterval: number;
            /** In ms */
            pingTimeout: number;
            /** Timeout for answers while scanning in ms */
            scanResponseTimeout: number;
            user: string;
            /** Stored encrypted (encryptedNative) */
            password: string;
            /** Log all data received from the bus */
            debug: boolean;
            readAtStart: boolean;
            /** Input and output relays are the same states */
            combinedRelays: boolean;
        }
    }
}

export {}; // required, so the file counts as a module
