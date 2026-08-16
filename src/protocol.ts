/**
 * Message construction and parsing. Pure functions, no I/O.
 *
 * This is a deliberate line-for-line port of `zengge/protocol.py` from the
 * zengge-ledenet-py project, so that both implementations can be checked
 * against the SAME captured frames (test/captures.json). If you change a byte
 * layout here, change it there too, and only because a capture says so.
 *
 * The authoritative reference is docs/PROTOCOL.md in that project.
 */

export const WRAPPER_MAGIC = Buffer.from([0xb0, 0xb1, 0xb2, 0xb3, 0x00, 0x01]);

export const POWER_ON = 0x23;
export const POWER_OFF = 0x24;

export const COLOR_MODE_RGB = 0xf0;
export const COLOR_MODE_WHITE = 0x0f;

export const WRITE_MODE_COLOR = 0xa1;
export const WRITE_MODE_WHITE = 0xb1;

export const TIMER_ENABLED = 0xf0;
export const TIMER_DISABLED = 0x0f;
export const TIMER_EMPTY = 0x00;
export const EVERY_DAY = 0xfe;

/** Per-pixel frames render cleanly up to about this rate. There is NO
 *  backpressure signal: the socket accepts frames far faster than the device
 *  renders them and reports total success while the lights stutter. */
export const SAFE_PIXEL_HZ = 5.0;

export function checksum(data: Buffer): number {
  let sum = 0;
  for (const b of data) {
    sum += b;
  }
  return sum & 0xff;
}

export function withChecksum(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.from([checksum(data)])]);
}

/**
 * Wrap an inner message in the b0-b1-b2-b3 outer frame.
 *
 * The inner message carries NO checksum of its own -- the outer checksum
 * covers everything. Adding one makes the device accept the message and do
 * nothing at all.
 */
export function wrap(inner: Buffer, counter = 0, version = 0x02): Buffer {
  const header = Buffer.concat([
    WRAPPER_MAGIC,
    Buffer.from([
      version,
      counter & 0xff,
      (inner.length >> 8) & 0xff,
      inner.length & 0xff,
    ]),
  ]);
  return withChecksum(Buffer.concat([header, inner]));
}

/** Strip an outer frame if present; otherwise return the input unchanged. */
export function unwrap(data: Buffer): Buffer {
  if (data.length >= 10 && data.subarray(0, 4).equals(WRAPPER_MAGIC.subarray(0, 4))) {
    const length = (data[8] << 8) | data[9];
    return data.subarray(10, 10 + length);
  }
  return data;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface State {
  raw: Buffer;
  model: number;
  version: number;
  isOn: boolean;
  mode: number;
  /** active animation id */
  pattern: number;
  speed: number;
  colorMode: number;
  /** 0-358; stored on the wire as hue/2 */
  hue: number;
  saturation: number;
  value: number;
}

export const STATE_QUERY_BARE = withChecksum(Buffer.from([0x81, 0x8a, 0x8b]));
/** for the wrapped form -- note the EA prefix */
export const STATE_QUERY_INNER = Buffer.from([0xea, 0x81, 0x8a, 0x8b]);

/**
 * Decode a state reply, unwrapping an outer frame if present.
 *
 * Do NOT decode this with a classic 14-byte LEDENET map; the offsets differ
 * and produce plausible nonsense.
 */
export function parseState(data: Buffer): State {
  const buf = unwrap(data);
  if (buf.length < 20 || buf[0] !== 0xea || buf[1] !== 0x81) {
    throw new Error(`not an EA 81 state frame: ${buf.toString('hex')}`);
  }
  return {
    raw: Buffer.from(buf),
    model: buf[4],
    version: buf[5],
    isOn: buf[6] === POWER_ON,
    mode: buf[7],
    pattern: buf[8],
    speed: buf[9],
    colorMode: buf[10],
    hue: buf[11] * 2,
    saturation: buf[12],
    value: buf[13],
  };
}

export function isRgb(state: State): boolean {
  return state.colorMode === COLOR_MODE_RGB;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/** Bare message; does not need wrapping. */
export function power(on: boolean): Buffer {
  return withChecksum(Buffer.from([0x71, on ? POWER_ON : POWER_OFF, 0x0f]));
}

/**
 * Inner message for a single colour across the whole strand.
 * hue 0-358 (halved on the wire), saturation and value 0-100.
 * Saturation 0 renders white.
 */
export function solidColor(hue: number, saturation: number, value: number): Buffer {
  return Buffer.from([
    0xe0, 0x01, 0x00, WRITE_MODE_COLOR,
    Math.floor(hue / 2) & 0xff, saturation & 0xff, value & 0xff,
    0x00, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00,
  ]);
}

export interface Color {
  /** 0-358 */
  hue?: number;
  /** 0-100; 0 renders white */
  saturation?: number;
  /** 0-100 */
  value?: number;
  /** dedicated white channel, 0-100 */
  white?: number;
}

function fill(c: Color): Required<Color> {
  return {
    hue: c.hue ?? 0,
    saturation: c.saturation ?? 100,
    value: c.value ?? 100,
    white: c.white ?? 0,
  };
}

/**
 * Inner message for an animated scene.
 *
 * `colors` is a REPEATING MOTIF, not per-pixel data: three entries repeat
 * around the whole strand. Repeat an entry to lengthen its run -- four reds
 * followed by four blues gives blocks of four.
 *
 * `param7` is byte 7, whose meaning is unknown. It reads 0x64 on most scenes
 * but a captured 6-colour scene used 0x4A, so it cannot be hardcoded: doing so
 * reproduces that scene incorrectly while still producing a message the device
 * accepts. Pass the captured value through.
 *
 * Use `perPixel` when you need to address lights individually.
 */
export function scene(
  pattern: number,
  colors: Color[],
  speed = 50,
  brightness = 100,
  style = 0x00,
  param7 = 0x64,
): Buffer {
  if (colors.length === 0) {
    throw new Error('a scene needs at least one colour');
  }
  const head = Buffer.from([
    0xe1, 0x21, 0x00, brightness & 0xff, pattern & 0xff,
    style & 0xff, 0x01, param7 & 0xff, speed & 0xff,
    0, 0, 0, 0, 0, 0, colors.length,
  ]);
  const body = Buffer.concat(
    colors.map((raw) => {
      const c = fill(raw);
      return Buffer.from([
        Math.floor(c.hue / 2), c.saturation, c.value, 0x00, c.white,
      ]);
    }),
  );
  return Buffer.concat([head, body]);
}

/**
 * Inner message setting every pixel individually.
 *
 * `colors` must contain exactly one entry per physical light, in strand order.
 * Note the entry width here is 7 bytes, where `scene` uses 5.
 *
 * Message size is `9 + colors.length * 7`. See the render-rate warning before
 * streaming these: there is no backpressure, and the device silently drops
 * frames it cannot keep up with.
 */
export function perPixel(colors: Color[], brightness = 100, seq = 0): Buffer {
  const n = colors.length;
  if (n < 1 || n > 255) {
    throw new Error('pixel count must be 1-255');
  }
  const head = Buffer.from([
    0xe1, 0x23, seq & 0xff, 0x00, 0x01, brightness & 0xff, 0x64, 0x00, n,
  ]);
  const body = Buffer.concat(
    colors.map((raw) => {
      const c = fill(raw);
      return Buffer.from([
        0x00, Math.floor(c.hue / 2), c.saturation, c.value,
        0x00, 0x00, c.white ? c.white : 0x64,
      ]);
    }),
  );
  return Buffer.concat([head, body]);
}

/**
 * Inner message streaming one audio level, 0-100.
 *
 * The controller performs no audio analysis; it just renders the number.
 * The vendor app streams these at a fixed 120 ms interval (8.33 Hz).
 */
export function musicLevel(level: number): Buffer {
  return Buffer.from([0xe1, 0x07, Math.max(0, Math.min(100, level))]);
}

// ---------------------------------------------------------------------------
// clock
// ---------------------------------------------------------------------------

export const CLOCK_READ = withChecksum(Buffer.from([0x11, 0x1a, 0x1b, 0x0f]));

/** `weekday` is Mon=1..Sun=7. */
export function clockWrite(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number, weekday: number,
): Buffer {
  return Buffer.from([
    0x10, 0x14, year % 100, month, day, hour, minute, second, weekday, 0x00, 0x0f,
  ]);
}

export function parseClock(
  data: Buffer,
): [number, number, number, number, number, number, number] {
  const b = unwrap(data);
  if (b.length < 11) {
    throw new Error(`short clock reply: ${b.toString('hex')}`);
  }
  return [2000 + b[3], b[4], b[5], b[6], b[7], b[8], b[9]];
}

// ---------------------------------------------------------------------------
// on-device timers
// ---------------------------------------------------------------------------

export const TIMERS_READ = Buffer.from([0xe0, 0x06]);
/** the app brackets timer writes with this, before and after */
export const TIMER_COMMIT = Buffer.from([0xe0, 0x0e, 0x01]);

export const PAYLOAD_POWER_ON = Buffer.concat([
  Buffer.from([0xe0, 0x01, 0x00, POWER_ON]), Buffer.alloc(10),
]);
export const PAYLOAD_POWER_OFF = Buffer.concat([
  Buffer.from([0xe0, 0x01, 0x00, POWER_OFF]), Buffer.alloc(10),
]);

export interface Timer {
  slot: number;
  enabled: number;
  hour: number;
  minute: number;
  second: number;
  daymask: number;
  payload: Buffer;
}

export function timerIsEmpty(t: Timer): boolean {
  return t.enabled === TIMER_EMPTY && t.payload.length === 0;
}

/**
 * Build a timer-write message.
 *
 * ⚠️ UNSETTLED: this emits a trailing checksum, matching the timer section of
 * PROTOCOL.md, but the framing rule says inner messages carry none. Whether an
 * e0 05 message goes bare or wrapped is not yet confirmed by a capture. Do not
 * "fix" this in either direction until it is.
 */
export function timerWrite(
  slot: number, hour: number, minute: number, payload: Buffer,
  enabled = true, daymask = EVERY_DAY, second = 0,
): Buffer {
  const body = Buffer.concat([
    Buffer.from([
      0xe0, 0x05, slot, enabled ? TIMER_ENABLED : TIMER_DISABLED,
      hour, minute, second, daymask, payload.length,
    ]),
    payload,
  ]);
  return withChecksum(body);
}

/** Clear a slot: a write with every field zeroed. */
export function timerDelete(slot: number): Buffer {
  return withChecksum(Buffer.from([0xe0, 0x05, slot, 0, 0, 0, 0, 0, 0]));
}

/**
 * Walk the variable-length slot records in an `e0 06` reply.
 *
 * Records are NOT fixed size: an empty slot is 7 bytes, a populated one carries
 * its payload inline. Assuming a fixed stride yields nothing and fails silently.
 */
export function parseTimers(data: Buffer): Timer[] {
  const inner = unwrap(data);
  const out: Timer[] = [];
  let i = 2; // skip the echoed e0 06
  while (i + 7 <= inner.length) {
    const length = inner[i + 6];
    out.push({
      slot: inner[i],
      enabled: inner[i + 1],
      hour: inner[i + 2],
      minute: inner[i + 3],
      second: inner[i + 4],
      daymask: inner[i + 5],
      payload: inner.subarray(i + 7, i + 7 + length),
    });
    i += 7 + length;
  }
  return out;
}

export function describePayload(payload: Buffer): string {
  const head = payload.subarray(0, 4);
  if (head.equals(Buffer.from([0xe0, 0x01, 0x00, POWER_ON]))) {
    return 'power on';
  }
  if (head.equals(Buffer.from([0xe0, 0x01, 0x00, POWER_OFF]))) {
    return 'power off';
  }
  if (payload.subarray(0, 2).equals(Buffer.from([0xe1, 0x21]))) {
    return `scene pattern 0x${payload[4].toString(16).padStart(2, '0')}`;
  }
  return `payload ${payload.toString('hex')}`;
}
