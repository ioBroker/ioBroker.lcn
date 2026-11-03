import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
    DeviceManagement,
    type ActionContext,
    type ConfigItemAny,
    type DeviceAction,
    type DeviceDetails,
    type DeviceInfo,
    type DeviceLoadContext,
    type DeviceRefreshResponse,
    type InstanceDetails,
    type InstanceRefreshResponse,
} from '@iobroker/dm-utils';
import type { AdapterInstance } from '@iobroker/adapter-core';
import { t } from './i18n';
import { SCAN_STEP } from './lcn';
import type { LcnDeviceNative, ScanProgress, ScanResultInfo } from './types';

/** One LCN module as stored in the objects */
export interface LcnDevice {
    /** ID without namespace, e.g. `S000.M010` */
    id: string;
    common: ioBroker.DeviceCommon;
    native: LcnDeviceNative;
}

/** Settings of a module that cannot be detected by the scan */
export interface LcnDeviceSettings {
    relaysOut: number;
    regulator: boolean;
    display: boolean;
}

/** What the device manager needs from the adapter */
export interface LcnAdapterApi extends AdapterInstance {
    getLcnDevices(): LcnDevice[];
    isLcnConnected(): boolean;
    /**
     * Scan the bus
     *
     * @param range "max" or "min-max"
     * @param onProgress called on every scan step
     */
    scanRange(range: string, onProgress?: (progress: ScanProgress) => void): Promise<ScanResultInfo>;
    /** Read the states of all modules. Returns the number of modules */
    readAllStates(): number;
    updateDeviceSettings(id: string, settings: LcnDeviceSettings): Promise<void>;
}

/** build/lib → admin/icons */
const ICONS_DIR = join(__dirname, '..', '..', 'admin', 'icons');

const SCAN_RANGE = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/;

export class LcnDeviceManagement extends DeviceManagement<LcnAdapterApi> {
    private readonly iconExists = new Map<string, boolean>();

    protected override getInstanceInfo(): InstanceDetails {
        return {
            apiVersion: 'v3',
            identifierLabel: t('Address'),
            actions: [
                {
                    id: 'scan',
                    icon: 'search',
                    title: t('Scan'),
                    description: t('Scan the LCN bus for modules'),
                    handler: (context: ActionContext): Promise<InstanceRefreshResponse> => this.onScan(context),
                },
                {
                    id: 'readAll',
                    icon: 'refresh',
                    description: t('Read the states of all modules'),
                    handler: async (context: ActionContext): Promise<InstanceRefreshResponse> => {
                        if (!this.adapter.isLcnConnected()) {
                            await context.showMessage(t('LCN is not connected'));
                        } else {
                            const count = this.adapter.readAllStates();
                            await context.showMessage(t('Status read of %s modules started', count));
                        }
                        return { refresh: false };
                    },
                },
            ],
        };
    }

    protected override loadDevices(context: DeviceLoadContext<string>): void {
        const devices = this.adapter
            .getLcnDevices()
            .sort((a, b) => a.native.segment - b.native.segment || a.native.module - b.native.module);
        context.setTotalDevices(devices.length);
        for (const device of devices) {
            context.addDevice(this.buildDeviceInfo(device));
        }
    }

    protected override getDeviceDetails(id: string): DeviceDetails<string> | null | { error: string } {
        const device = this.findDevice(id);
        if (!device) {
            return { error: 'Device not found' };
        }
        const native = device.native;
        const items: Record<string, ConfigItemAny> = {
            _segment: this.staticItem(t('Segment'), native.segment),
            _module: this.staticItem(t('Module'), native.module),
        };
        if (native.serial) {
            items._serial = this.staticItem(t('Serial number'), native.serial);
        }
        if (native.fwVersion) {
            items._fwVersion = this.staticItem(t('Firmware'), native.fwVersion);
        }
        if (native.hwType !== undefined && native.hwType !== '') {
            items._hwType = this.staticItem(t('Hardware type'), native.hwType);
        }
        if (native.manufacturer !== undefined && native.manufacturer !== '') {
            items._manufacturer = this.staticItem(t('Manufacturer'), native.manufacturer);
        }
        const counts: [keyof LcnDeviceNative, string][] = [
            ['analogs', 'Analogs'],
            ['relays', 'Relays'],
            ['leds', 'LEDs'],
            ['sensors', 'Sensors'],
            ['vars', 'Variables'],
            ['counters', 'Counters'],
            ['limits', 'Limits'],
            ['relaysOut', 'Output relays'],
        ];
        for (const [attr, label] of counts) {
            const value = native[attr];
            if (typeof value === 'number' && value) {
                items[`_${attr}`] = this.staticItem(t(label), value);
            }
        }
        if (native.regulator) {
            items._regulator = this.staticItem(t('Regulator'), '✓');
        }
        if (native.display) {
            items._display = this.staticItem(t('Display'), '✓');
        }
        return { id, schema: { type: 'panel', items } };
    }

    private findDevice(id: string): LcnDevice | undefined {
        return this.adapter.getLcnDevices().find(device => device.id === id);
    }

    private getIcon(hwType: string | number | undefined): string | undefined {
        if (hwType === undefined || hwType === '') {
            return undefined;
        }
        const name = String(hwType);
        let exists = this.iconExists.get(name);
        if (exists === undefined) {
            // hwType comes from the bus, so it must not leave the icons folder
            exists = /^[-\w]+$/.test(name) && existsSync(join(ICONS_DIR, `${name}.png`));
            this.iconExists.set(name, exists);
        }
        // The icons are too big (up to 125 KB) to send them base64 encoded with every device list
        return exists ? `./adapter/${this.adapter.name}/icons/${name}.png` : undefined;
    }

    private buildDeviceInfo(device: LcnDevice): DeviceInfo<string> {
        const native = device.native;
        const actions: DeviceAction<string>[] = [
            {
                id: 'settings',
                icon: 'edit',
                description: t('Module settings'),
                handler: (id: string, context: ActionContext): Promise<DeviceRefreshResponse<string>> =>
                    this.onSettings(id, context),
            },
            {
                id: 'rescan',
                icon: 'refresh',
                description: t('Rescan'),
                handler: (id: string, context: ActionContext): Promise<DeviceRefreshResponse<string>> =>
                    this.onRescan(id, context),
            },
        ];

        return {
            id: device.id,
            name: device.common.name || device.id,
            identifier: `S${native.segment}:M${native.module}`,
            icon: this.getIcon(native.hwType),
            model: native.hwType !== undefined ? String(native.hwType) : undefined,
            manufacturer: native.manufacturer !== undefined ? String(native.manufacturer) : undefined,
            hasDetails: true,
            actions,
        };
    }

    private staticItem(label: ioBroker.StringOrTranslated, data: string | number): ConfigItemAny {
        return { type: 'staticInfo', label, data, xs: 12, sm: 6 };
    }

    /** Scan with a progress dialog */
    private async scan(context: ActionContext, range: string): Promise<ScanResultInfo | null> {
        if (!this.adapter.isLcnConnected()) {
            await context.showMessage(t('LCN is not connected'));
            return null;
        }
        const m = range.match(SCAN_RANGE);
        if (!m) {
            await context.showMessage(t('Invalid scan range "%s"', range));
            return null;
        }
        const max = parseInt(m[2] || m[1], 10);

        const progress = await context.openProgress(t('Scan'), { value: 0, label: t('Detecting...') });
        let info: ScanResultInfo;
        try {
            info = await this.adapter.scanRange(range, step => {
                let update: Parameters<typeof progress.update>[0];
                if (step.step === SCAN_STEP.SCANNING) {
                    update = {
                        indeterminate: false,
                        value: max ? Math.min(100, Math.round((step.progress / max) * 100)) : 0,
                        label: t('Detecting module %s of %s, found %s', step.progress, max, step.found),
                    };
                } else if (step.step === SCAN_STEP.READING) {
                    update = { indeterminate: true, label: t('Reading info of module %s...', step.progress) };
                } else {
                    return;
                }
                progress.update(update).catch(e => this.adapter.log.debug(`Cannot update progress: ${e}`));
            });
        } catch (e) {
            await progress.close();
            await context.showMessage(t('Cannot scan: %s', String(e)));
            return null;
        }
        await progress.close();
        return info;
    }

    private async onScan(context: ActionContext): Promise<InstanceRefreshResponse> {
        const result = await context.showForm(
            {
                type: 'panel',
                items: {
                    range: {
                        type: 'text',
                        label: t('Max module for scan'),
                        help: t('E.g. "250" or "5-30"'),
                        xs: 12,
                    },
                },
            },
            { data: { range: '250' }, title: t('Scan'), buttons: ['apply', 'cancel'] },
        );
        if (!result) {
            return { refresh: false };
        }
        const info = await this.scan(context, String(result.range ?? ''));
        if (!info) {
            return { refresh: false };
        }
        await context.showMessage(t('Found %s devices, new of them %s devices.', info.total, info._new));
        return { refresh: true };
    }

    private async onRescan(id: string, context: ActionContext): Promise<DeviceRefreshResponse<string>> {
        const device = this.findDevice(id);
        if (!device) {
            return { refresh: 'devices' };
        }
        const module = device.native.module;
        const info = await this.scan(context, `${module}-${module}`);
        if (!info) {
            return { refresh: 'none' };
        }
        if (!info.total) {
            await context.showMessage(t('Module %s did not answer', module));
        }
        return { refresh: 'devices' };
    }

    private async onSettings(id: string, context: ActionContext): Promise<DeviceRefreshResponse<string>> {
        const device = this.findDevice(id);
        if (!device) {
            return { refresh: 'devices' };
        }
        const result = await context.showForm(
            {
                type: 'panel',
                items: {
                    relaysOut: {
                        type: 'number',
                        label: t('Output relays'),
                        help: t('Number of output relays that must be created'),
                        min: 0,
                        max: 8,
                        xs: 12,
                    },
                    regulator: { type: 'checkbox', label: t('Regulator'), newLine: true, xs: 12 },
                    display: { type: 'checkbox', label: t('Display'), newLine: true, xs: 12 },
                },
            },
            {
                data: {
                    relaysOut: device.native.relaysOut || 0,
                    regulator: !!device.native.regulator,
                    display: !!device.native.display,
                },
                title: t('Module settings'),
                buttons: ['apply', 'cancel'],
            },
        );
        if (!result) {
            return { refresh: 'none' };
        }
        const relaysOut = Math.max(0, Math.min(8, parseInt(String(result.relaysOut), 10) || 0));
        await this.adapter.updateDeviceSettings(id, {
            relaysOut,
            regulator: !!result.regulator,
            display: !!result.display,
        });
        return { refresh: 'devices' };
    }
}
