import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { Client } from './client';
import type { DeviceConfig, SceneConfig, ZenggePlatform } from './platform';

/** A device entry whose address is known -- the platform resolves this by
 *  discovery before constructing an accessory, so it is not optional here. */
export type ResolvedDevice = DeviceConfig & { host: string };
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
  private readonly scenes: SceneConfig[];

  constructor(
    private readonly platform: ZenggePlatform,
    private readonly accessory: PlatformAccessory,
    device: ResolvedDevice,
  ) {
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'ZENGGE / LEDENET')
      .setCharacteristic(Characteristic.Model, 'model 0x6E (ZG-BL-HONGRUI)')
      .setCharacteristic(Characteristic.SerialNumber, device.mac ?? device.host);

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

    this.scenes = device.scenes ?? [];

    // Drop switches for scenes that are no longer configured. Homebridge keeps
    // cached services forever otherwise, so removing a scene from config would
    // leave a dead switch in the Home app that controls nothing.
    const wanted = new Set(this.scenes.map((sc) => `scene-${sc.name}`));
    for (const service of [...this.accessory.services]) {
      if (service.UUID === Service.Switch.UUID
          && service.subtype
          && !wanted.has(service.subtype)) {
        this.platform.log.info(`Removing scene switch "${service.displayName}"`);
        this.accessory.removeService(service);
      }
    }

    for (const scene of this.scenes) {
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

    // The client polls for state on ONE persistent connection. It does not
    // reconnect per query -- that is the failure mode that stalls this
    // hardware. Relying on the device's unprompted pushes was tried and does
    // not work: a passive listener never hears anything and reports every
    // accessory as off.
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
          scene.param7 ?? 0x64,
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

    // Which scene is running CAN be recovered, even though the palette cannot:
    // the state frame carries the pattern id and speed, and those two together
    // identify a configured scene. Two scenes may share a pattern id and differ
    // only in speed, so both must match -- id alone is not enough.
    const match = this.scenes.find(
      (sc) => sc.pattern === s.pattern && (sc.speed ?? 50) === s.speed,
    );
    const matchedName = match ? match.name : null;
    if (matchedName !== this.activeScene) {
      this.activeScene = matchedName;
      for (const [name, service] of this.sceneSwitches) {
        service.updateCharacteristic(Characteristic.On, name === matchedName);
      }
      if (matchedName) {
        this.platform.log.debug(`${this.accessory.displayName}: scene "${matchedName}" is running`);
      }
    }

    // ⚠️ ONLY power is taken from the device.
    //
    // The state frame's colour bytes do not describe what the strand is
    // actually showing. Under a running scene they are meaningless: observed
    // reading 354/100/78 under every scene on one unit, and 0/0/0 on real
    // hardware while a scene ran (2026-08-16). Copying them into HomeKit
    // showed the lamp at 0% brightness, and worse, that 0 then became the
    // value written back on the next colour change -- a wrong reading turning
    // into a wrong command.
    //
    // So colour and brightness are HomeKit's own model, not the device's.
    // There is no way to read back what a scene is really displaying.
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
