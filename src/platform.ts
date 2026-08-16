import type {
  API, Characteristic, DynamicPlatformPlugin, Logger,
  PlatformAccessory, PlatformConfig, Service,
} from 'homebridge';

import { ControllerAccessory } from './accessory';
import type { ResolvedDevice } from './accessory';
import { discover } from './discovery';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import type { Color } from './protocol';

export interface SceneConfig {
  name: string;
  /** animation/pattern id byte */
  pattern: number;
  speed?: number;
  brightness?: number;
  style?: number;
  /** Byte 7. Unknown purpose; 0x64 on most scenes, but some use another value
   *  and hardcoding it reproduces those scenes incorrectly. */
  param7?: number;
  colors: Color[];
}

export interface DeviceConfig {
  name: string;
  /** Optional: controllers are discovered by UDP broadcast if not given. */
  host?: string;
  /** Stable identity, filled in by discovery. Addresses move; MACs do not. */
  mac?: string;
  port?: number;
  /** Number of lights on the strand. There is no way to read this from the
   *  device, so it must be configured for any per-pixel work. */
  pixels?: number;
  scenes?: SceneConfig[];
}

export interface ZenggeConfig extends PlatformConfig {
  devices?: DeviceConfig[];
}

export class ZenggePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  private readonly controllers: ControllerAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: ZenggeConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((err) => {
        this.log.error(`startup failed: ${(err as Error).message}`);
      });
    });
    this.api.on('shutdown', () => {
      for (const c of this.controllers) {
        c.stop();
      }
    });
  }

  /** Homebridge replays cached accessories to us on restart. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  private async discoverDevices(): Promise<void> {
    const devices = [...(this.config.devices ?? [])];

    // Anything without an address, plus the whole list if none was configured,
    // is resolved by broadcast. A layperson does not know their controller's
    // IP and should not have to.
    const needsDiscovery = devices.length === 0 || devices.some((d) => !d.host);
    if (needsDiscovery) {
      this.log.info('Searching the network for controllers…');
      const found = await discover();

      if (found.length === 0) {
        this.log.warn(
          'No controllers found. They answer a UDP broadcast on port 48899, '
          + 'which some networks block — if yours does, add the IP address '
          + 'manually in the plugin settings.',
        );
      }

      for (const f of found) {
        this.log.info(`Found ${f.model} at ${f.ip}`);
      }

      // Fill in configured entries that gave no address, matching by MAC when
      // one was recorded, otherwise by position for a single controller.
      for (const device of devices) {
        if (device.host) {
          continue;
        }
        const match = device.mac
          ? found.find((f) => f.mac === device.mac!.replace(/[^0-9a-fA-F]/g, '').toUpperCase())
          : found[0];
        if (match) {
          device.host = match.ip;
          device.mac = match.mac;
        }
      }

      // Nothing configured at all: adopt everything we found.
      if ((this.config.devices ?? []).length === 0) {
        found.forEach((f, i) => {
          devices.push({
            name: found.length === 1 ? 'LED Controller' : `LED Controller ${i + 1}`,
            host: f.ip,
            mac: f.mac,
          });
        });
      }
    }

    if (devices.length === 0) {
      return;
    }

    for (const device of devices) {
      if (!device.host || !device.name) {
        this.log.error(
          `Skipping a device entry with no address: ${JSON.stringify({ name: device.name })}`,
        );
        continue;
      }

      // Key on the MAC when we have one, so a moved DHCP lease does not create
      // a duplicate accessory. Entries configured with an explicit address keep
      // their address-based identity for backwards compatibility.
      const resolved = device as ResolvedDevice;
      const identity = device.mac ?? device.host;
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${identity}`);
      const existing = this.accessories.find((a) => a.UUID === uuid);

      if (existing) {
        existing.context.device = resolved;
        this.api.updatePlatformAccessories([existing]);
        this.controllers.push(new ControllerAccessory(this, existing, resolved));
        this.log.info(`Restored ${device.name} (${device.host})`);
      } else {
        const accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = resolved;
        this.controllers.push(new ControllerAccessory(this, accessory, resolved));
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added ${device.name} (${device.host})`);
      }
    }
  }
}
