/**
 * Structural + golden tests for the TypeScript protocol port.
 *
 * These deliberately mirror tests/test_protocol.py and tests/test_golden.py in
 * the zengge-ledenet-py project, and read the SAME captures.json. Two
 * independent implementations checked against one set of captured frames is a
 * much stronger guarantee than either alone -- if they diverge, one of them is
 * wrong about the hardware.
 *
 *     npm test        (builds first, then runs this)
 *
 * ⛔ A golden capture is evidence, never an expected value. If a golden test
 *    fails, the BUILDER is wrong. Never edit captures.json to make it pass.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const p = require('../dist/protocol.js');

const CAPTURES = path.join(__dirname, 'captures.json');

function isPending(value) {
  if (typeof value === 'string') {
    return value.trim().toUpperCase().startsWith('TODO');
  }
  if (Array.isArray(value)) {
    return value.some(isPending);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some(isPending);
  }
  return false;
}

describe('checksum and framing', () => {
  it('sums and masks', () => {
    assert.strictEqual(p.checksum(Buffer.from([1, 2, 3])), 6);
    assert.strictEqual(p.checksum(Buffer.from([0xff, 0xff])), 0xfe);
  });

  it('matches the published bare state query 81 8a 8b 96', () => {
    assert.strictEqual(p.STATE_QUERY_BARE.toString('hex'), '818a8b96');
  });

  it('matches the published clock read 11 1a 1b 0f 55', () => {
    assert.strictEqual(p.CLOCK_READ.toString('hex'), '111a1b0f55');
  });

  it('lays the wrapper out correctly with a big-endian length', () => {
    const out = p.wrap(Buffer.from([0xaa, 0xbb]), 0x07, 0x02);
    assert.deepStrictEqual(out.subarray(0, 6), Buffer.from([0xb0, 0xb1, 0xb2, 0xb3, 0x00, 0x01]));
    assert.strictEqual(out[6], 0x02);
    assert.strictEqual(out[7], 0x07);
    assert.deepStrictEqual(out.subarray(8, 10), Buffer.from([0x00, 0x02]));
    assert.strictEqual(out[out.length - 1], p.checksum(out.subarray(0, out.length - 1)));
  });

  it('uses big-endian for a 256-byte inner message', () => {
    const out = p.wrap(Buffer.alloc(256));
    assert.deepStrictEqual(out.subarray(8, 10), Buffer.from([0x01, 0x00]));
  });

  it('round-trips wrap/unwrap', () => {
    const inner = Buffer.from([0xe1, 0x23, 0x00, 0x01]);
    assert.deepStrictEqual(p.unwrap(p.wrap(inner)), inner);
  });

  it('passes bare data through unwrap unchanged', () => {
    const bare = Buffer.from([0xea, 0x81, 0x00, 0x01]);
    assert.deepStrictEqual(p.unwrap(bare), bare);
  });

  it('emits no inner checksum on wrapped builders', () => {
    const builders = {
      solidColor: p.solidColor(30, 36, 100),
      scene: p.scene(0x03, [{ hue: 0 }]),
      perPixel: p.perPixel([{ hue: 0 }]),
      musicLevel: p.musicLevel(50),
    };
    for (const [name, msg] of Object.entries(builders)) {
      const body = msg.subarray(0, msg.length - 1);
      assert.notStrictEqual(
        msg[msg.length - 1], p.checksum(body),
        `${name} looks like it ends in its own checksum`,
      );
    }
  });
});

describe('state frame', () => {
  function frame(over = {}) {
    const buf = Buffer.alloc(28);
    buf[0] = 0xea; buf[1] = 0x81;
    buf[4] = 0x6e; buf[5] = 0x11;
    buf[6] = p.POWER_ON; buf[7] = 0x25; buf[8] = 0x66; buf[9] = 50;
    buf[10] = p.COLOR_MODE_RGB; buf[11] = 0xb1; buf[12] = 100; buf[13] = 78;
    buf[27] = buf[6];
    for (const [k, v] of Object.entries(over)) {
      buf[Number(k)] = v;
    }
    return buf;
  }

  it('reads the documented offsets', () => {
    const s = p.parseState(frame());
    assert.strictEqual(s.model, 0x6e);
    assert.strictEqual(s.pattern, 0x66);
    assert.strictEqual(s.speed, 50);
    assert.strictEqual(s.value, 78);
    assert.strictEqual(s.isOn, true);
  });

  it('doubles the hue (0xB1 = 354 degrees)', () => {
    assert.strictEqual(p.parseState(frame()).hue, 354);
  });

  it('reads power from byte 6, not byte 2', () => {
    assert.strictEqual(p.parseState(frame({ 6: p.POWER_OFF, 2: 0x01 })).isOn, false);
    assert.strictEqual(p.parseState(frame({ 6: p.POWER_OFF, 2: 0x02 })).isOn, false);
    assert.strictEqual(p.parseState(frame({ 6: p.POWER_ON, 2: 0x01 })).isOn, true);
  });

  it('accepts a wrapped reply', () => {
    assert.strictEqual(p.parseState(p.wrap(frame())).model, 0x6e);
  });

  it('rejects a non-EA81 frame', () => {
    assert.throws(() => p.parseState(Buffer.alloc(22)));
  });
});

describe('commands', () => {
  it('builds bare power messages with a checksum', () => {
    for (const msg of [p.power(true), p.power(false)]) {
      assert.strictEqual(msg[msg.length - 1], p.checksum(msg.subarray(0, msg.length - 1)));
    }
    assert.deepStrictEqual(p.power(true).subarray(0, 3), Buffer.from([0x71, 0x23, 0x0f]));
    assert.deepStrictEqual(p.power(false).subarray(0, 3), Buffer.from([0x71, 0x24, 0x0f]));
  });

  it('builds a 14-byte solid colour with the 0x14 constant', () => {
    const msg = p.solidColor(30, 36, 100);
    assert.strictEqual(msg.length, 14);
    assert.deepStrictEqual(msg.subarray(0, 4), Buffer.from([0xe0, 0x01, 0x00, 0xa1]));
    assert.strictEqual(msg[4], 15);
    assert.strictEqual(msg[11], 0x14);
  });

  it('uses 5-byte scene entries and 7-byte per-pixel entries', () => {
    const n = 4;
    const colors = Array.from({ length: n }, () => ({ hue: 0 }));
    assert.strictEqual(p.scene(0x03, colors).length, 16 + n * 5);
    assert.strictEqual(p.perPixel(colors).length, 9 + n * 7);
  });

  it('defaults scene byte 7 to 0x64 but allows overriding it', () => {
    // Settled against six captured scene frames: five carried 0x64, one 0x4A.
    // Hardcoding it reproduced that scene wrongly while still being accepted.
    assert.strictEqual(p.scene(0x03, [{ hue: 0 }])[7], 0x64);
    assert.strictEqual(p.scene(0x42, [{ hue: 0 }], 50, 100, 0, 0x4a)[7], 0x4a);
  });

  it('maps per-pixel entry order to light index', () => {
    const msg = p.perPixel([{ hue: 0 }, { hue: 120 }, { hue: 240 }]);
    const hues = [0, 1, 2].map((i) => msg[9 + i * 7 + 1] * 2);
    assert.deepStrictEqual(hues, [0, 120, 240]);
  });

  it('rejects an out-of-range pixel count', () => {
    assert.throws(() => p.perPixel([]));
    assert.throws(() => p.perPixel(Array.from({ length: 256 }, () => ({}))));
  });

  it('clamps the music level instead of wrapping it', () => {
    assert.strictEqual(p.musicLevel(255)[2], 100);
    assert.strictEqual(p.musicLevel(-5)[2], 0);
  });
});

describe('timers', () => {
  it('walks variable-length slot records', () => {
    const payload = p.PAYLOAD_POWER_OFF;
    const reply = Buffer.concat([
      Buffer.from([0xe0, 0x06]),
      Buffer.from([1, 0xf0, 6, 15, 0, 0xfe, payload.length]), payload,
      Buffer.from([2, 0, 0, 0, 0, 0, 0]),
      Buffer.from([3, 0xf0, 22, 0, 0, 0xfe, payload.length]), payload,
    ]);
    const timers = p.parseTimers(reply);
    assert.deepStrictEqual(timers.map((t) => t.slot), [1, 2, 3]);
    assert.deepStrictEqual(timers.map((t) => t.hour), [6, 0, 22]);
    assert.strictEqual(p.timerIsEmpty(timers[1]), true);
  });

  it('changes only the enabled flag when disabling', () => {
    const on = p.timerWrite(1, 7, 0, p.PAYLOAD_POWER_ON, true);
    const off = p.timerWrite(1, 7, 0, p.PAYLOAD_POWER_ON, false);
    assert.strictEqual(on[3], 0xf0);
    assert.strictEqual(off[3], 0x0f);
    assert.deepStrictEqual(
      on.subarray(4, on.length - 1), off.subarray(4, off.length - 1),
    );
  });

  it('builds the documented zeroed delete record', () => {
    const msg = p.timerDelete(1);
    assert.strictEqual(msg.length, 10);
    assert.deepStrictEqual(msg.subarray(0, 9), Buffer.from([0xe0, 0x05, 1, 0, 0, 0, 0, 0, 0]));
  });

  it('uses 14-byte power payloads', () => {
    assert.strictEqual(p.PAYLOAD_POWER_ON.length, 14);
    assert.strictEqual(p.PAYLOAD_POWER_OFF.length, 14);
  });
});

describe('golden captures', () => {
  const entries = JSON.parse(fs.readFileSync(CAPTURES, 'utf8')).captures;

  function build(name, args) {
    switch (name) {
      case 'timer_write':
        return p.timerWrite(
          args.slot, args.hour, args.minute,
          Buffer.from(args.payload_hex, 'hex'),
          args.enabled ?? true, args.daymask ?? p.EVERY_DAY, args.second ?? 0,
        );
      case 'timer_delete':
        return p.timerDelete(args.slot);
      case 'scene':
        return p.scene(args.pattern, args.colors, args.speed, args.brightness, args.style);
      case 'per_pixel':
        return p.perPixel(args.colors, args.brightness, args.seq);
      case 'solid_color':
        return p.solidColor(args.hue, args.saturation, args.value);
      case 'power':
        return p.power(args.on);
      default:
        throw new Error(`no builder mapping for ${name}`);
    }
  }

  for (const entry of entries) {
    const pending = isPending(entry.capture_hex);
    it(`${entry.name}${pending ? ' (pending capture)' : ''}`, (t) => {
      if (pending) {
        return t.skip('capture not recorded yet');
      }

      const captured = Buffer.from(entry.capture_hex.replace(/\s+/g, ''), 'hex');
      const wrapped = captured.subarray(0, 4).equals(p.WRAPPER_MAGIC.subarray(0, 4));

      if (!isPending(entry.framing)) {
        assert.strictEqual(
          wrapped ? 'wrapped' : 'bare', entry.framing,
          `${entry.name}: recorded framing does not match the bytes`,
        );
      }

      if (entry.builder === null) {
        const state = p.parseState(captured);
        for (const [field, want] of Object.entries(entry.expect ?? {})) {
          assert.strictEqual(state[field === 'is_on' ? 'isOn' : field], want);
        }
        return undefined;
      }

      assert.ok(!isPending(entry.args), `${entry.name}: capture filled in but args are TODO`);
      const expected = p.unwrap(captured);
      const actual = build(entry.builder, entry.args);
      assert.strictEqual(
        actual.toString('hex'), expected.toString('hex'),
        `\n${entry.name}: builder output does not match the capture.`
        + `\n  captured: ${expected.toString('hex')}`
        + `\n  built:    ${actual.toString('hex')}`
        + '\nThe CAPTURE is the evidence. Fix the builder.',
      );
      return undefined;
    });
  }
});
