# homebridge-zengge-ledenet

HomeKit support, via [Homebridge](https://homebridge.io), for **ZENGGE / LEDENET
LED controllers running newer OEM firmware** — model `0x6E`, firmware string
`ZG-BL-HONGRUI` — which existing Magic Home plugins cannot talk to.

If `homebridge-magichome` (or anything else built on `flux_led`) fails to detect
your controller, this is why: the 2025 firmware replaced the classic Magic Home
command set. Every documented LEDENET opcode is either ignored or actively
breaks the connection.

> **Status: early but working.** Power, colour and brightness are confirmed
> against real hardware from the Home app, with a human watching the lights.
> The protocol is fully reverse-engineered and documented in
> [zengge-ledenet-py](https://github.com/crimsontech79/zengge-ledenet-py)
> (`docs/PROTOCOL.md`) — that document is the authoritative reference and the
> point of both projects. This plugin is the HomeKit front end for it.

## 📣 Please tell us whether it worked

**This has only ever been tested against one controller, on one network.**

That is the honest situation, and it is why your experience matters more than
usual here. Whether it worked perfectly, half-worked, or did nothing at all —
[**tell us in an issue**](https://github.com/crimsontech79/homebridge-zengge-ledenet/issues/new/choose).
There are two one-minute forms: one for bugs, one just for saying which
controller you have and whether it worked.

You do not need to diagnose anything. "It found my lights but the colour wheel
does nothing" is a genuinely useful report. So is "it works fine" — that is how
the list of known-good hardware gets built.

Permanent outdoor lighting is sold under a lot of names — Trimlight, Gemstone,
EverLights, Jellyfish, and many regional installers — usually with a generic
ZENGGE controller inside. Whether *yours* speaks this command set is an open
question, and nobody can answer it without you.

## What works

| Capability | HomeKit surface |
|---|---|
| Power on / off | Lightbulb |
| Colour (hue / saturation) | Lightbulb |
| Brightness | Lightbulb |
| Saved scenes / animations | optional Switch per configured scene — see below |
| Live state | polled on the held connection |

Per-pixel control and music-reactive mode are implemented in the protocol layer
but have no HomeKit representation — HomeKit has no vocabulary for either. They
are available to code, and could later be surfaced as switches that start an
effect.

## Install

```
npm install -g homebridge-zengge-ledenet
```

**That is usually all the setup there is.** Controllers answer a UDP broadcast,
so the plugin finds them by itself — no IP address, no DHCP reservation, no
network knowledge needed. An empty platform block works:

```json
{ "platform": "ZenggeLedenet" }
```

If your network blocks broadcast, or you want to name things yourself, configure
devices explicitly via the Homebridge UI or a platform block:

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

Accessories are identified by MAC address, not IP, so a controller whose DHCP
lease moves is still recognised as the same accessory rather than reappearing as
a duplicate.

## Scenes (advanced, optional)

**Most people should ignore this section.** The plugin works fully without it.

This firmware has no "recall saved scene" command and no way to list scenes, and
a scene's palette is not readable back from the device — the palette travels
inside the command. So a scene switch can only be built by capturing the exact
bytes your vendor app sends, which means running a packet capture against your
own controller. That is a reverse-engineering exercise, not configuration, and
it is why scenes are opt-in rather than the headline feature.

### Finding your scene ids

There is no command that lists scenes. Run a scene in the vendor app and read
**byte 8** of the device state frame — that is the pattern id, and **byte 9** is
the speed. You need both: two scenes can share a pattern id and differ only in
speed.

Connect to TCP 5577, send the bare state query `81 8a 8b 96` every few seconds
on that one connection, and watch those bytes move as you tap through your
scenes. Reads are free, so this needs no writes at all.

A pattern id identifies the *motion*, not the scene. The palette is not readable
back from the device at all — it lives in the command — which is why scenes are
configured here rather than recalled.

## Design constraints — do not "fix" these

These are not stylistic choices. Each one cost real debugging time, and a
Homebridge plugin is unusually likely to trip over the first two.

- **One persistent connection — but do poll on it.** Homebridge's instinct is
  to poll a characteristic and open a socket to do it. Ten quick
  connect/query/close cycles leave this controller answering nothing for **over
  a minute**, which looks exactly like broken hardware. What hurts is
  *reconnecting* per query, not querying: this plugin holds one socket open and
  polls state on it every 30 s.
- **Do not rely on the device pushing state.** It has been seen doing so, but
  not dependably: against real hardware a purely passive listener received
  nothing across 18 minutes and several connections, leaving every accessory
  stuck reporting "off". Ask, don't wait.
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

## Reporting a bug, or a device that does not work

[**Open an issue**](https://github.com/crimsontech79/homebridge-zengge-ledenet/issues/new/choose)
— there are forms for both a bug and a plain "here's my hardware" report.

If you are reporting something broken, turn on debug logging first (`homebridge -D`, or "Debug Mode" in the Homebridge
UI settings) and include:

- What you expected, and what happened instead.
- The plugin's log lines — they start `[ZenggeLedenet]`.
- The controller's **model string**, which the plugin logs at startup as
  `Found <model> at <address>`.
- Your Homebridge and Node versions.

🔒 **Your logs are safe to paste.** Discovery replies on newer firmware include a
32-character hex value of unknown purpose. It looks like a device secret, so this
plugin never logs or stores it — there is a test enforcing that. If you gather
information with some *other* tool, redact any 32-character hex string before
posting it.

### A controller this plugin cannot talk to

Especially welcome. If the plugin finds your controller but nothing works, say so
and include the model string — that is a useful data point even without a fix,
and it is how the list of known hardware grows. If it does not find it at all,
say that too: some networks block the UDP broadcast discovery relies on, and
that is worth knowing about.

### Things that are known, and not bugs

- **Scene switches need a packet capture to configure.** There is no scene-recall
  command in this firmware and a scene's palette cannot be read back. See the
  scenes section above.
- **Changing colour ends a running scene, permanently.** There is no command to
  restore one; it has to be re-selected in the vendor app.
- **Per-pixel and music-reactive modes are not exposed to HomeKit**, which has no
  vocabulary for either. They exist in the protocol layer.
- **Turning a scene switch off does nothing to the lights.** There is no "stop
  scene" command, so the plugin leaves them alone rather than guessing.

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
