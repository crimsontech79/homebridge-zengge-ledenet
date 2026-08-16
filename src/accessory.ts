import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { Client } from './client';
import type { DeviceConfig, SceneConfig, ZenggePlatform } from './platform';
import type { State } from './protocol';

/**
 * HomeKit sends Hue and Saturation as two SEPARATE characteristic writes when
 * you drag the colour picker. Sending a command for each produces two writes
 * per change, the first with a stale half of the colour. Coalesce them.
 */
const COLOR_COALESCE_MS = 50;

export class ControllerAccessory {
  private readonly light: Service;
  private readonly sceneSwitches = new Map<string, Service>();
  private readonly client: Client;

  /** What HomeKit believes. The device's own state frame is authoritative for
   *  power, but it does NOT report the palette of a running scene, so colour is
   *  tracked locally between pushes. */
  private state = { on: false, hue: 0, saturation: 100, brightness: 100 };

  private colorTimer: NodeJS.Timeout | null = null;
  private activeScene: string | null = null;

  constructor(
    private readonly platform: ZenggePlatform,
    private readonly accessory: PlatformAccessory,
    device: DeviceConfig,
  ) {
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'ZENGGE / LEDENET')
      .setCharacteristic(Characteristic.Model, 'model 0x6E (ZG-BL-HONGRUI)')
      .setCharacteristic(Characteristic.SerialNumber, device.host);

    this.light = this.accessory.getService(Service.Lightbulb)
      ?? this.accessory.addService(Service.Lightbulb, device.name);

    this.light.getCharacteristic(Characteristic.On)
      .onGet(() => this.state.on)
      .onSet((v) => this.setOn(v));

    this.light.getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.state.brightness)
      .onSet((v) => this.setBrightness(v));

    this.light.getCharacteristic(Characteristic.Hue)
      .onGet(() => this.state.hue)
      .onSet((v) => this.setHue(v));

    this.light.getCharacteristic(Characteristic.Saturation)
      .onGet(() => this.state.saturation)
      .onSet((v) => this.setSaturation(v));

    for (const scene of device.scenes ?? []) {
      this.addSceneSwitch(scene);
    }

    this.client = new Client({
      host: device.host,
      port: device.port,
      log: {
        debug: (m) => this.platform.log.debug(m),
        info: (m) => this.platform.log.info(m),
        warn: (m) => this.platform.log.warn(m),
        error: (m) => this.platform.log.error(m),
      },
    });

    // The device pushes its state roughly every 30 s and within seconds of a
    // change, so we listen instead of polling. Polling would mean a socket per
    // request, which is the failure mode that stalls this hardware.
    this.client.on('state', (s) => this.onDeviceState(s));
    this.client.start();
  }

  stop(): void {
    if (this.colorTimer) {
      clearTimeout(this.colorTimer);
    }
    this.client.stop();
  }

  // -- scene switches ------------------------------------------------------

  private addSceneSwitch(scene: SceneConfig): void {
    const { Service, Characteristic } = this.platform;
    const subtype = `scene-${scene.name}`;

    const service = this.accessory.getServiceById(Service.Switch, subtype)
      ?? this.accessory.addService(Service.Switch, scene.name, subtype);

    service.getCharacteristic(Characteristic.On)
      .onGet(() => this.activeScene === scene.name)
      .onSet((value) => {
        if (!value) {
          // Turning a scene switch off is ambiguous on this hardware: there is
          // no "stop scene" command. Leave the lights alone and just clear the
          // flag, rather than guessing.
          if (this.activeScene === scene.name) {
            this.activeScene = null;
          }
          return;
        }
        this.client.setScene(
          scene.pattern,
          scene.colors,
          scene.speed ?? 50,
          scene.brightness ?? 100,
          scene.style ?? 0,
        );
        this.activeScene = scene.name;
        // Scenes are mutually exclusive: only one palette is running.
        for (const [name, other] of this.sceneSwitches) {
          if (name !== scene.name) {
            other.updateCharacteristic(Characteristic.On, false);
          }
        }
      });

    this.sceneSwitches.set(scene.name, service);
  }

  // -- from the device -----------------------------------------------------

  private onDeviceState(s: State): void {
    const { Characteristic } = this.platform;

    if (s.isOn !== this.state.on) {
      this.state.on = s.isOn;
      this.light.updateCharacteristic(Characteristic.On, s.isOn);
    }

    // ⚠️ The state frame's colour bytes do NOT track a running scene's palette
    // -- they read the same under every scene. Only trust them when the device
    // is showing a solid colour, otherwise HomeKit would show a wrong swatch.
    if (this.activeScene === null) {
      this.state.hue = Math.min(360, s.hue);
      this.state.saturation = s.saturation;
      this.state.brightness = s.value;
      this.light.updateCharacteristic(Characteristic.Hue, this.state.hue);
      this.light.updateCharacteristic(Characteristic.Saturation, s.saturation);
      this.light.updateCharacteristic(Characteristic.Brightness, s.value);
    }
  }

  // -- from HomeKit --------------------------------------------------------

  private setOn(value: CharacteristicValue): void {
    this.state.on = value as boolean;
    this.client.setPower(this.state.on);
  }

  private setBrightness(value: CharacteristicValue): void {
    this.state.brightness = value as number;
    this.queueColor();
  }

  private setHue(value: CharacteristicValue): void {
    this.state.hue = value as number;
    this.queueColor();
  }

  private setSaturation(value: CharacteristicValue): void {
    this.state.saturation = value as number;
    this.queueColor();
  }

  private queueColor(): void {
    if (this.colorTimer) {
      clearTimeout(this.colorTimer);
    }
    this.colorTimer = setTimeout(() => {
      this.colorTimer = null;
      // Any manual colour change means we are no longer running a scene.
      this.activeScene = null;
      for (const service of this.sceneSwitches.values()) {
        service.updateCharacteristic(this.platform.Characteristic.On, false);
      }
      this.client.setSolid(
        Math.min(358, Math.round(this.state.hue)),
        Math.round(this.state.saturation),
        Math.max(1, Math.round(this.state.brightness)),
      );
    }, COLOR_COALESCE_MS);
  }
}
