# homebridge-zengge-ledenet

HomeKit support, via [Homebridge](https://homebridge.io), for **ZENGGE / LEDENET
LED controllers running newer OEM firmware** — model `0x6E`, firmware string
`ZG-BL-HONGRUI` — which existing Magic Home plugins cannot talk to.

If `homebridge-magichome` (or anything else built on `flux_led`) fails to detect
your controller, this is why: the 2025 firmware replaced the classic Magic Home
command set. Every documented LEDENET opcode is either ignored or actively
breaks the connection.

> **Status: early.** The protocol is fully reverse-engineered and verified
> against real hardware, and is documented in
> [zengge-ledenet-py](https://github.com/crimsontech79/zengge-ledenet-py)
> (`docs/PROTOCOL.md`) — that document is the authoritative reference and the
> point of both projects. This plugin is the HomeKit front end for it.

## What works

| Capability | HomeKit surface |
|---|---|
| Power on / off | Lightbulb |
| Colour (hue / saturation) | Lightbulb |
| Brightness | Lightbulb |
| Saved scenes / animations | one Switch per configured scene |
| Live state | pushed by the device, no polling |

Per-pixel control and music-reactive mode are implemented in the protocol layer
but have no HomeKit representation — HomeKit has no vocabulary for either. They
are available to code, and could later be surfaced as switches that start an
effect.

## Install

```
npm install -g homebridge-zengge-ledenet
```

Then add a platform block, or use the Homebridge UI (a config schema ships with
the plugin):

```json
{
  "platform": "ZenggeLedenet",
  "devices": [
    {
      "name": "Outdoor Lights",
      "host": "192.168.1.50",
      "pixels": 100,
      "scenes": [
        {
          "name": "Warm White",
          "pattern": 102,
          "speed": 50,
          "colors": [{ "hue": 30, "saturation": 36, "value": 100 }]
        }
      ]
    }
  ]
}
```

**Give the controller a DHCP reservation.** These devices advertise no mDNS, so
a changed address silently breaks the accessory.

### Finding your scene ids

There is no command that lists scenes. Run a scene in the vendor app and read
**byte 8** of the device state frame — that is the pattern id. The controller
pushes its state to any connected client within seconds of a scene change, so
this needs **no writes at all**: connect to TCP 5577, listen, and watch byte 8
move as you tap through your scenes.

Note that a pattern id identifies the *motion*, not the scene: two scenes can
share an id and differ only in palette and speed. The palette lives in the
command, so it is configured here rather than recalled from the device.

## Design constraints — do not "fix" these

These are not stylistic choices. Each one cost real debugging time, and a
Homebridge plugin is unusually likely to trip over the first two.

- **One persistent connection.** Homebridge's instinct is to poll a
  characteristic and open a socket to do it. Ten quick connect/query/close
  cycles leave this controller answering nothing for **over a minute**, which
  looks exactly like broken hardware. This plugin holds one socket open and
  listens; the device pushes its state about every 30 s unprompted.
- **There is no backpressure.** `socket.write()` succeeds and reports total
  success while the lights stutter or freeze. **Send success tells you nothing
  about whether the LEDs moved.** Anything streaming frames must pace itself.
- **Pace per-pixel writes to ≤5 Hz.** 8 Hz visibly stutters — including on
  smooth, random content, which was assumed to hide dropped frames and does not.
- **Use ≥5 s timeouts.** These are 2.4 GHz devices and slow to accept; a 1 s
  timeout reports a healthy device as closed.
- **`e1 21` entries are 5 bytes and tile as a repeating motif; `e1 23` entries
  are 7 bytes and are true per-pixel.** Confusing them produces output that
  parses fine and looks wrong.

## Tests

```
npm test
```

`src/protocol.ts` is a deliberate line-for-line port of `zengge/protocol.py`,
and `test/captures.json` is the **same fixture file** used by the Python
project. Two independent implementations checked against one set of captured
frames is a far stronger guarantee than either alone — if they diverge, one of
them is wrong about the hardware.

⛔ **A golden capture is evidence, never an expected value.** If a golden test
fails, the builder is wrong. Never edit a capture to make a test pass.

## Credits

[`flux_led`](https://github.com/Danielhiversen/flux_led) and
[`homebridge-magichome`](https://github.com/hokify/homebridge-magichome) are the
established projects for Magic Home / LEDENET hardware and are excellent for the
devices they support. This is an independent implementation for a firmware they
do not cover. No code was copied from either.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).

## Not affiliated

Independent and unofficial. **Not affiliated with, endorsed by, or supported
by** ZENGGE, Magic Home, Apple, or any lighting installer or manufacturer.
Product names are used only to describe hardware compatibility. All trademarks
belong to their respective owners.
