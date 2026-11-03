/** Address of an LCN module or group */
export interface LcnAddress {
    segment: number;
    module: number;
    isGroup?: boolean;
    /** Register number for some read commands. The generators delete it from the address again */
    input?: number;
}

/** One piece of information parsed from a line received from the LCN bus */
export interface LcnState {
    segment: number;
    module: number;
    type?: string;
    /** parseMotor delivers the command name in `cmd` and not in `type` */
    cmd?: string;
    status?: number | boolean | string;
    input?: number | string;
    limit?: number;
    /** Positive acknowledge */
    success?: boolean;
    /** Negative acknowledge */
    error?: string | number;
    isName?: boolean;
    serial?: string;
    manufacturer?: string | number;
    hwType?: string | number;
    fwVersion?: string;
    segmentId?: number;
    value?: number;
    level?: number;
    key?: number;
    lowBat?: boolean;
    action?: number;
    stepOut?: number;
    stepIn?: number;
}

/** Module found by a scan */
export interface FoundModule {
    name: string;
    comment: string;
    states?: LcnState[];
    serial?: string;
    manufacturer?: string | number;
    hwType?: string | number;
    fwVersion?: string;
    segment?: number;
    module?: number;
}

/** Modules found by a scan, key is the module address */
export type FoundModules = Record<string, FoundModule | null>;

/** Progress of a scan, also written into the states scan.step, scan.progress and scan.found */
export interface ScanProgress {
    step: number;
    progress: number;
    found: number;
}

/** Result of a scan, sent back to the admin */
export interface ScanResultInfo {
    total: number;
    _new: number;
}

/** `native` of a device object (one LCN module), e.g. lcn.0.S000.M010 */
export interface LcnDeviceNative {
    segment: number;
    module: number;
    serial?: string;
    fwVersion?: string;
    hwType?: string | number;
    manufacturer?: string | number;
    name?: string;
    /** Number of output relays that must be created. Set by the user */
    relaysOut?: number;
    /** Create display output states. Set by the user */
    display?: boolean;
    /** Create regulator states. Set by the user or detected by the scan (then a number) */
    regulator?: boolean | number;
    analogs?: number;
    vars?: number;
    counters?: number;
    limits?: number;
    relays?: number;
    leds?: number;
    sensors?: number;
}

/** `native` of a state object, e.g. lcn.0.S000.M010.RELAYS.RELAY01 */
export interface LcnStateNative {
    segment: number;
    module: number;
    command: string;
    output?: number | string;
}

/** Task for `LCN.scanModules`: read the status of one module */
export interface ReadTask extends LcnAddress {
    native?: LcnDeviceNative;
}

export interface LcnLogger {
    debug(text: string): void;
    info(text: string): void;
    warn(text: string): void;
    error(text: string): void;
}

export interface ConnectionOptions {
    port?: number;
    host?: string;
    user?: string;
    password?: string;
    /** in ms */
    reconnectTimeout?: number;
    /** in ms */
    defaultTimeout?: number;
    /** in ms */
    pingInterval?: number;
    /** in ms */
    pingTimeout?: number;
    analogMode?: number;
    /** in ms */
    connectTimeout?: number;
    debug?: boolean;
    logger?: LcnLogger;
    resolveName?: (segment: number, module: number) => string;
}

export interface LcnOptions extends ConnectionOptions {
    logger: LcnLogger;
    segment?: number;
    /** in ms */
    scanResponseTimeout?: number;
}
