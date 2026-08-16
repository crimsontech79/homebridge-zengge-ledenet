import type {
  API, Characteristic, DynamicPlatformPlugin, Logger,
  PlatformAccessory, PlatformConfig, Service,
} from 'homebridge';

import { ControllerAccessory } from './accessory';
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
  host: string;
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

    this.api.on('didFinishLaunching', () => this.discoverDevices());
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

  private discoverDevices(): void {
    const devices = this.config.devices ?? [];
    if (devices.length === 0) {
      this.log.warn(
        'No devices configured. Add at least one { name, host } entry — this '
        + 'plugin does not auto-discover, because discovery needs a UDP '
        + 'broadcast that many networks drop.',
      );
      return;
    }

    for (const device of devices) {
      if (!device.host || !device.name) {
        this.log.error(`Skipping a device entry missing "name" or "host": ${JSON.stringify(device)}`);
        continue;
      }

      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.host}`);
      const existing = this.accessories.find((a) => a.UUID === uuid);

      if (existing) {
        existing.context.device = device;
        this.api.updatePlatformAccessories([existing]);
        this.controllers.push(new ControllerAccessory(this, existing, device));
        this.log.info(`Restored ${device.name} (${device.host})`);
      } else {
        const accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;
        this.controllers.push(new ControllerAccessory(this, accessory, device));
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added ${device.name} (${device.host})`);
      }
    }
  }
}
