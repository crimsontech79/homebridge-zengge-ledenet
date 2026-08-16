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
 * The controller also PUSHES its state unprompted roughly every 30 s, and
 * within seconds of a scene change, so we mostly do not need to poll at all.
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

export interface ClientOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
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
  readonly host: string;
  readonly port: number;

  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private counter = -1;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly timeoutMs: number;
  private readonly log: NonNullable<ClientOptions['log']>;

  /** Last state the device reported, from a push or a reply. */
  lastState: State | null = null;

  constructor(opts: ClientOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port ?? DEFAULT_PORT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.destroySocket();
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
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
      this.emit('close');
      this.scheduleReconnect();
    });
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
   * Send bytes exactly as given.
   *
   * Returning cleanly means only that the socket accepted the bytes. It is NOT
   * evidence the device acted on them.
   */
  sendRaw(payload: Buffer): void {
    if (!this.socket || this.socket.destroyed) {
      this.log.debug(`${this.host}: dropped a frame, not connected`);
      return;
    }
    this.socket.write(payload);
  }

  /** Wrap an inner message and send it. */
  send(inner: Buffer, version = 0x02): void {
    this.sendRaw(p.wrap(inner, this.nextCounter(), version));
  }

  /** Ask for a state frame. Usually unnecessary -- the device pushes. */
  requestState(): void {
    this.send(p.STATE_QUERY_INNER);
  }

  // -- operations ----------------------------------------------------------

  setPower(on: boolean): void {
    this.sendRaw(p.power(on));
  }

  /** A single colour across the whole strand. Saturation 0 is white. */
  setSolid(hue: number, saturation: number, value: number): void {
    this.send(p.solidColor(hue, saturation, value));
  }

  setScene(
    pattern: number, colors: p.Color[], speed = 50, brightness = 100, style = 0,
  ): void {
    this.send(p.scene(pattern, colors, speed, brightness, style));
  }

  setPixels(colors: p.Color[], brightness = 100, seq = 0): void {
    this.send(p.perPixel(colors, brightness, seq));
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
