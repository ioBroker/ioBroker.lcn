/** Result of the conversion of an LCN variable */
export interface ConvertedVariable {
    value: number;
    /** Unit, that belongs to the role. Set on the object, if it has no unit yet */
    unit?: string;
}

/**
 * Convert the raw value of an LCN variable (VARS.VARnn) into the value of the state.
 * The conversion depends on the role, that the user sets on the state.
 *
 * VAR02 and VAR03 (R1Var and R2Var of the regulators) are shown in °C, if the role does not define another
 * conversion. That is the behavior of all versions before 4.0.0, where the parser converted them always - so
 * a role like `value.temperature` converted them a second time.
 *
 * @param raw value received from the module
 * @param role role of the state, e.g. `value.temperature`
 * @param input number of the variable 1-12
 */
export function convertVariable(raw: number, role: string | undefined, input: number | undefined): ConvertedVariable {
    role ||= '';
    if (/^value\.temperature/.test(role)) {
        return { value: (raw - 1000) / 10, unit: '°C' };
    }
    if (/^value\.brightness/.test(role)) {
        // value = Math.round(Math.exp(1.689646994 + 0.010380664 * value) * 10) / 10;
        return { value: Math.round(Math.exp(raw / 100) * 10) / 10, unit: 'lux' };
    }
    if (/^value\.speed\.wind/.test(role)) {
        return { value: raw / 10, unit: 'm/s' };
    }
    if (/^value\.voltage/.test(role)) {
        return { value: raw / 400, unit: 'V' };
    }
    if (/^value\.current/.test(role)) {
        return { value: raw / 10 - 100, unit: 'A' };
    }
    if (/^value\.sun\.azimuth/.test(role) || /^value\.sun\.elevation/.test(role)) {
        return { value: raw / 10 - 100, unit: '°' };
    }
    if (input === 2 || input === 3) {
        return { value: (raw - 1000) / 10 };
    }
    return { value: raw };
}
