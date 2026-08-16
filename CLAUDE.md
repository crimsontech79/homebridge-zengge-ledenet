# homebridge-zengge-ledenet

Homebridge (HomeKit) plugin for ZENGGE / LEDENET controllers running newer OEM
firmware — model `0x6E`, `ZG-BL-HONGRUI`. TypeScript, published to npm.

**The authoritative protocol reference lives in the sibling project
`zengge-ledenet-py`, in `docs/PROTOCOL.md`.** Read it before writing any
protocol code. Do not re-derive protocol facts here.

## ⛔ This repository is PUBLIC — never commit anything identifying

The work originated on one person's home network. Before every commit, check for
MAC addresses, IP addresses, hostnames, the 32-hex discovery token, specific
pixel counts or zone boundaries, anyone's saved scenes, palettes or schedules,
and the name of the lighting installer.

**Everything generic and configurable**: pixel count, scenes, device address are
all config, with neutral defaults. Example addresses use the `192.168.1.x`
documentation range.

## `src/protocol.ts` is a PORT, not an independent implementation

It is a deliberate line-for-line port of `zengge/protocol.py`. Keep it that way:

- If you change a byte layout here, change it there too — and only because a
  **capture** says so, never because it looks wrong.
- `test/captures.json` is a copy of the Python project's fixture file. When one
  side gains a capture, copy it across. Two implementations checked against one
  fixture set is the whole point.
- Divergence between the two is a bug in one of them, not a style difference.

## Design constraints (learned the hard way — do not "fix" these)

- **One persistent connection, polled.** Homebridge polls characteristics, and
  the natural implementation opens a socket per poll. Ten quick
  connect/query/close cycles stall this controller for over a minute — it looks
  like dead hardware. `Client` holds one socket and polls state on it.
  **Never add a polling timer that reconnects** — the timer is fine, the
  reconnect is what kills it.
- **Do not rely on unprompted pushes.** Tried and disproven against real
  hardware 2026-08-16: a passive listener got nothing in 18 minutes across
  several connections, so every accessory reported "off". The reference Python
  client polls, and so must this.
- **Use the BARE state query** `81 8a 8b 96`. Both framings are documented as
  working, but bare is the one with mileage on real hardware.
- **The socket's idle timeout must not tear down the connection.** An idle
  socket is expected — this device speaks only when asked.
- **There is no backpressure.** `write()` succeeds while the lights stutter or
  freeze. Send success is not evidence the LEDs moved.
- **Pace per-pixel writes to ≤5 Hz**; 8 Hz visibly stutters even on smooth
  content.
- **Use ≥5 s timeouts.** 2.4 GHz devices, slow to accept.
- **Inner messages carry no checksum**; the wrapper's covers all. ⚠️ Known
  exception under investigation: the `e0 05` timer builders emit one. Do not
  "fix" either way until a capture settles it.
- **`e1 21` entries are 5 bytes (repeating motif); `e1 23` entries are 7 bytes
  (true per-pixel).** Confusing them parses fine and looks wrong.

## HomeKit mapping constraints

- **HomeKit sends Hue and Saturation as separate writes.** They must be
  coalesced, or every colour change sends two commands, the first with a stale
  half of the colour. `COLOR_COALESCE_MS` in `accessory.ts` does this.
- **Never take colour or brightness from the state frame.** Its colour bytes do
  not describe what the strand is showing: observed as a constant under every
  scene on one unit, and as `0/0/0` on real hardware mid-scene. Copying them in
  showed 0% brightness AND made 0 the value written back on the next colour
  change. Colour is HomeKit's model; only power comes from the device.
- **Which scene is running IS recoverable** — pattern id (byte 8) plus speed
  (byte 9) together identify a configured scene. Match on both: ids collide,
  and speed is what separates them.
- **There is no "stop scene" command.** Turning a scene switch off clears the
  flag and leaves the lights alone rather than guessing.
- **HomeKit cannot express per-pixel or music mode.** Do not invent a
  characteristic for them; surface them as switches that start an effect, or
  leave them to code.

## Verification rule

**A state byte moving is not proof the lights did anything**, and the reverse is
also true. Anything claiming to change light output needs a human to look at it
before it is documented as working.

## Tests

    npm test        # builds, then runs node --test

⛔ **A golden capture is evidence, never an expected value.** If a golden test
fails, the builder is wrong. Never edit `captures.json`, delete a failing
capture, or re-mark it `TODO` to get a green run.

Tests must run with no device and no network.

## Legal posture

- Reverse engineering for interoperability; no protection measure was
  circumvented — the protocol is plaintext on a local network.
- `flux_led` (LGPL-3.0-or-later) and `homebridge-magichome` are credited. **No
  code was copied.** Do not vendor or paste their source.
- No vendor trademarks in the package name; factual compatibility only.

## Layout

    src/protocol.ts   byte building and parsing, pure functions (port)
    src/client.ts     persistent connection, polling, pacing
    src/platform.ts   Homebridge dynamic platform
    src/accessory.ts  Lightbulb + scene switches
    test/             structural + golden tests, shared fixture
