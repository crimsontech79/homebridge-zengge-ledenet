/**
 * Controller client: one persistent connection, plus the pacing rules the
 * hardware needs.
 *
 * Two constraints drive this whole file, and both are easy to get wrong in a
 * Homebridge plugin specifically:
 *
 *   1. ONE PERSISTENT CONNECTION. Homebridge's natural instinct is to poll a
 *      characteristic and open a socket to do it. Ten quick connect/query/close
 *      cycles leave this controller answering nothing for over a minute, which
 *      looks exactly like a broken device. So we hold a socket open and listen.
 *
 *   2. NO BACKPRESSURE. `socket.write()` succeeds and reports total success
 *      while the lights stutter or freeze. Send success tells you NOTHING about
 *      whether the LEDs moved. Anything streaming frames must pace itself.
 *
 * ⚠️ The controller has been observed pushing state unprompted, but it does NOT
 * do so reliably for a purely passive listener: a plugin that only listens sits
 * at its default state forever and reports every accessory as off. Verified
 * against real hardware 2026-08-16 -- zero frames in 18 minutes across several
 * connections. So we POLL, on the one persistent connection.
 *
 * Polling is not in tension with constraint 1. What stalls this controller is
 * RECONNECTING per query, not querying. One socket, polled, is the same shape
 * the reference Python client uses.
 */
import { EventEmitter } from 'events';
import * as net from 'net';

import * as p from './protocol';
import type { State } from './protocol';

export const DEFAULT_PORT = 5577;

/** These are 2.4 GHz devices and slow to accept. A 1 s timeout reports a
 *  perfectly healthy device as closed. */
export const DEFAULT_TIMEOUT_MS = 8000;

/** The device closes an idle connection about every 3 minutes. That is normal,
 *  not a fault -- but reconnecting in a tight loop is what stalls it, so back
 *  off and never dip below this floor. */
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 60000;

/** How often to ask the device for its state, on the connection we already
 *  hold. Reads are free; it is reconnecting that hurts. */
const DEFAULT_POLL_MS = 30000;

/**
 * Minimum spacing between anything we put on the wire.
 *
 * Measured 2026-08-16: dragging a HomeKit colour-temperature slider produced 26
 * writes in about 8 s, typically 250-350 ms apart, and the lights behaved
 * unreliably. The reference Python client waits a full second after every
 * write, so that was roughly 4x a rate known to work. Worse, nothing
 * coordinated writes with the state poll -- two frames went out 3 ms apart.
 *
 * There is no backpressure on this hardware: every one of those writes
 * "succeeded". Pacing is the only control available.
 */
const DEFAULT_WRITE_GAP_MS = 400;

export interface ClientOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
  /** State poll interval in ms. Reads are cheap; the default is 30 s. */
  pollIntervalMs?: number;
  /** Minimum gap between outbound frames, in ms. Default 400. */
  writeGapMs?: number;
  log?: {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export declare interface Client {
  on(event: 'state', listener: (state: State) => void): this;
  on(event: 'connect', listener: () => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export class Client extends EventEmitter {
  host: string;
  readonly port: number;

  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private counter = -1;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly writeGapMs: number;

  /**
   * Outbound queue, newest-wins per key.
   *
   * A slider drag emits a stream of values of which only the LAST matters, so a
   * queued frame with the same key is replaced rather than appended. That both
   * cuts the rate and guarantees the final value lands -- a plain rate limiter
   * that drops the tail would leave the lights on whatever the user dragged
   * past, which is worse than being slow.
   */
  private outbox = new Map<string, Buffer>();
  private drainTimer: NodeJS.Timeout | null = null;
  private lastWriteAt = 0;
  private readonly log: NonNullable<ClientOptions['log']>;

  /** Last state the device reported, from a push or a reply. */
  lastState: State | null = null;

  constructor(opts: ClientOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port ?? DEFAULT_PORT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.writeGapMs = opts.writeGapMs ?? DEFAULT_WRITE_GAP_MS;
    /* eslint-disable no-console */
    this.log = opts.log ?? {
      debug: () => undefined,
      info: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    };
    /* eslint-enable no-console */
  }

  // -- connection ----------------------------------------------------------

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.stopPolling();
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.outbox.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.destroySocket();
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /**
   * Point at a new address, e.g. after re-discovering a device whose DHCP
   * lease moved. Drops any current socket so the next attempt uses the new
   * address.
   */
  setHost(host: string): void {
    if (host === this.host) {
      return;
    }
    this.log.info(`address moved: ${this.host} -> ${host}`);
    this.host = host;
    this.destroySocket();
  }

  private connect(): void {
    if (this.stopped || this.socket) {
      return;
    }

    const sock = net.createConnection({ host: this.host, port: this.port });
    this.socket = sock;
    sock.setTimeout(this.timeoutMs);

    sock.on('connect', () => {
      this.log.debug(`${this.host}: connected`);
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.buffer = Buffer.alloc(0);
      this.emit('connect');
      // Ask immediately so HomeKit shows the truth rather than our defaults,
      // then keep asking on this same socket.
      this.requestState();
      this.startPolling();
    });

    sock.on('data', (chunk) => this.onData(chunk));

    sock.on('timeout', () => {
      // An idle socket is expected -- the device only speaks every ~30 s.
      // Do NOT tear the connection down here; that is the rapid-reconnect trap.
      this.log.debug(`${this.host}: socket idle`);
    });

    sock.on('error', (err) => {
      this.log.debug(`${this.host}: ${err.message}`);
      this.emit('error', err);
    });

    sock.on('close', () => {
      this.socket = null;
      this.stopPolling();
      this.emit('close');
      this.scheduleReconnect();
    });
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.requestState(), this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private destroySocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const delay = this.reconnectDelay;
    this.log.debug(`${this.host}: closed by device; reconnecting in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  // -- receiving -----------------------------------------------------------

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Frames arrive either bare or wrapped, and the device pushes unprompted.
    // Rather than parse a length-prefixed stream, look for the EA 81 state
    // frame anywhere in what has arrived and consume up to its end.
    for (;;) {
      const frame = this.takeStateFrame();
      if (!frame) {
        break;
      }
      try {
        const state = p.parseState(frame);
        this.lastState = state;
        this.log.debug(
          `${this.host}: state power=${state.isOn ? 'on' : 'off'} `
          + `pattern=0x${state.pattern.toString(16).padStart(2, '0')} `
          + `speed=${state.speed} hsv=${state.hue}/${state.saturation}/${state.value}`,
        );
        this.emit('state', state);
      } catch (err) {
        this.log.debug(`${this.host}: undecodable frame: ${(err as Error).message}`);
      }
    }

    // Never let a stream of unrecognised bytes grow without bound.
    if (this.buffer.length > 4096) {
      this.buffer = this.buffer.subarray(this.buffer.length - 1024);
    }
  }

  /** Pull one complete 28-byte EA 81 frame out of the buffer, if present. */
  private takeStateFrame(): Buffer | null {
    const STATE_LEN = 28;
    for (let i = 0; i + 2 <= this.buffer.length; i++) {
      if (this.buffer[i] === 0xea && this.buffer[i + 1] === 0x81) {
        if (this.buffer.length < i + STATE_LEN) {
          return null; // frame still arriving
        }
        const frame = this.buffer.subarray(i, i + STATE_LEN);
        this.buffer = this.buffer.subarray(i + STATE_LEN);
        return Buffer.from(frame);
      }
    }
    return null;
  }

  // -- sending -------------------------------------------------------------

  private nextCounter(): number {
    this.counter = (this.counter + 1) % 255;
    return this.counter;
  }

  /**
   * Queue a frame, newest-wins for the given key.
   *
   * Returning cleanly means only that the frame was queued -- and even once
   * written, that only means the socket accepted it. It is NOT evidence the
   * device acted on it.
   */
  sendRaw(payload: Buffer, key = 'raw'): void {
    // Map.set on an existing key keeps its position but takes the new value,
    // so a superseded slider value is replaced in place rather than piling up.
    this.outbox.set(key, payload);
    this.drain();
  }

  /** Wrap an inner message and queue it. */
  send(inner: Buffer, version = 0x02, key = 'raw'): void {
    this.sendRaw(p.wrap(inner, this.nextCounter(), version), key);
  }

  /** Write one queued frame, then reschedule while any remain. */
  private drain(): void {
    if (this.drainTimer || this.outbox.size === 0) {
      return;
    }
    const wait = Math.max(0, this.lastWriteAt + this.writeGapMs - Date.now());
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      const next = this.outbox.entries().next();
      if (!next.done) {
        const [key, payload] = next.value;
        this.outbox.delete(key);
        this.writeNow(payload);
      }
      if (this.outbox.size > 0) {
        this.drain();
      }
    }, wait);
  }

  private writeNow(payload: Buffer): void {
    if (!this.socket || this.socket.destroyed) {
      this.log.debug(`${this.host}: dropped a frame, not connected`);
      return;
    }
    const now = Date.now();
    const gap = this.lastWriteAt ? now - this.lastWriteAt : -1;
    const inner = p.unwrap(payload);
    const op = inner.length >= 4 && inner[0] === 0xe0
      ? `e0 01 00 ${inner[3].toString(16)}`
      : inner.subarray(0, 2).toString('hex');
    this.log.debug(
      `${this.host}: TX ${op} (${payload.length}B)${gap >= 0 ? ` +${gap}ms` : ''}`,
    );
    this.lastWriteAt = now;
    this.socket.write(payload);
  }

  /**
   * Ask for a state frame.
   *
   * Uses the BARE query. PROTOCOL.md says both framings work, but bare is the
   * form the reference client has always used against this hardware, so it is
   * the one with mileage on it.
   */
  requestState(): void {
    this.sendRaw(p.STATE_QUERY_BARE, 'state');
  }

  // -- operations ----------------------------------------------------------

  setPower(on: boolean): void {
    this.sendRaw(p.power(on), 'power');
  }

  /** A single colour across the whole strand. Saturation 0 is white. */
  setSolid(hue: number, saturation: number, value: number): void {
    // Shares the 'look' key with setWhite: they are alternative answers to
    // the same question, so a queued one must never outlive a newer one.
    this.send(p.solidColor(hue, saturation, value), 0x02, 'look');
  }

  /** Drive the dedicated white channel. Both values 0-100. UNVERIFIED. */
  setWhite(temperature: number, brightness: number): void {
    this.send(p.white(temperature, brightness), 0x02, 'look');
  }

  setScene(
    pattern: number, colors: p.Color[], speed = 50, brightness = 100, style = 0,
    param7 = 0x64,
  ): void {
    this.send(p.scene(pattern, colors, speed, brightness, style, param7), 0x02, 'look');
  }

  setPixels(colors: p.Color[], brightness = 100, seq = 0): void {
    // Coalescing is the right backpressure policy for animation: a frame
    // that could not go out yet is replaced by the newer one.
    this.send(p.perPixel(colors, brightness, seq), 0x02, 'pixels');
  }

  /**
   * Push per-pixel frames at a paced rate. Resolves when the last frame has
   * been handed to the socket -- which, again, is not the same as rendered.
   *
   * Pacing is not optional. Above ~5 Hz the output visibly stutters; far above
   * it, almost nothing renders at all, with zero errors reported.
   */
  async streamPixels(
    frames: Iterable<p.Color[]>,
    hz = p.SAFE_PIXEL_HZ,
    brightness = 100,
  ): Promise<number> {
    const interval = 1000 / Math.min(hz, p.SAFE_PIXEL_HZ);
    const start = Date.now();
    let sent = 0;
    for (const frame of frames) {
      this.setPixels(frame, brightness, sent & 0xff);
      sent += 1;
      const due = start + sent * interval - Date.now();
      if (due > 0) {
        await new Promise((r) => setTimeout(r, due));
      }
    }
    return sent;
  }
}
