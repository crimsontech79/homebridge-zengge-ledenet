/**
 * Outbound pacing, tested against a real TCP server on loopback.
 *
 * This is the fix for a measured failure: dragging a HomeKit slider produced 26
 * writes in ~8 s at 250-350 ms spacing and the lights behaved unreliably. The
 * hardware gives no backpressure, so every one of those writes "succeeded".
 *
 * Two properties matter, and the second is the subtle one:
 *
 *   1. frames are spaced by at least writeGapMs
 *   2. the LAST value a caller asked for always arrives
 *
 * A naive rate limiter satisfies (1) and violates (2) by dropping the tail,
 * which would leave the lights on whatever value the user dragged past.
 */
const assert = require('node:assert');
const net = require('node:net');
const { describe, it } = require('node:test');

const { Client } = require('../dist/client.js');
const p = require('../dist/protocol.js');

const silent = {
  debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined,
};

/** A server that records every frame it receives, with arrival times. */
function recordingServer() {
  const frames = [];
  const server = net.createServer((sock) => {
    sock.on('data', (chunk) => frames.push({ at: Date.now(), bytes: Buffer.from(chunk) }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, frames, port: server.address().port });
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pull the white-mode frames out, decoding the temperature byte. */
function whiteTemps(frames) {
  return frames
    .map((f) => p.unwrap(f.bytes))
    .filter((b) => b.length >= 8 && b[0] === 0xe0 && b[3] === p.WRITE_MODE_WHITE)
    .map((b) => b[7]);
}

describe('outbound pacing', () => {
  it('coalesces a burst and still delivers the final value', async () => {
    const { server, frames, port } = await recordingServer();
    const client = new Client({
      host: '127.0.0.1', port, writeGapMs: 100,
      pollIntervalMs: 60000, log: silent,
    });
    client.start();
    await wait(150);

    // A slider drag: ten values as fast as the event loop allows.
    for (let temp = 1; temp <= 10; temp += 1) {
      client.setWhite(temp * 10, 100);
    }

    await wait(900);
    client.stop();
    server.close();

    const temps = whiteTemps(frames);
    assert.ok(temps.length > 0, 'no white frames arrived at all');
    assert.ok(
      temps.length < 10,
      `expected coalescing to drop intermediate values, got all ${temps.length}`,
    );
    assert.strictEqual(
      temps[temps.length - 1], 100,
      'the FINAL value must land -- dropping the tail leaves the lights wrong',
    );
  });

  it('spaces frames by at least the configured gap', async () => {
    const { server, frames, port } = await recordingServer();
    const client = new Client({
      host: '127.0.0.1', port, writeGapMs: 120,
      pollIntervalMs: 60000, log: silent,
    });
    client.start();
    await wait(150);

    // Distinct keys so nothing coalesces away -- this measures spacing only.
    client.setWhite(10, 100);
    client.setPower(true);
    client.requestState();
    client.setScene(0x03, [{ hue: 0 }]);

    await wait(1200);
    client.stop();
    server.close();

    const times = frames.map((f) => f.at);
    assert.ok(times.length >= 3, `expected several frames, got ${times.length}`);
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i] - times[i - 1];
      // Generous floor: timers fire late, never early, but CI can be jittery.
      assert.ok(gap >= 90, `frames ${i - 1}->${i} only ${gap}ms apart`);
    }
  });

  it('treats colour and white as the same slot, so neither strands the other', async () => {
    const { server, frames, port } = await recordingServer();
    const client = new Client({
      host: '127.0.0.1', port, writeGapMs: 150,
      pollIntervalMs: 60000, log: silent,
    });
    client.start();
    await wait(150);

    // Ask for white, then immediately change mind and ask for colour.
    client.setWhite(80, 100);
    client.setSolid(120, 100, 100);

    await wait(500);
    client.stop();
    server.close();

    const inner = frames.map((f) => p.unwrap(f.bytes)).filter((b) => b[0] === 0xe0);
    const last = inner[inner.length - 1];
    assert.ok(last, 'no e0 frame arrived');
    assert.strictEqual(
      last[3], p.WRITE_MODE_COLOR,
      'the newer colour write must win; a stale white write must not follow it',
    );
  });

  it('does not flush stale frames onto a later connection', async () => {
    // stop() then start() must not deliver what was queued before the stop.
    // Without clearing the queue this passes silently until someone restarts a
    // client, at which point the lights jump to a value the user set minutes
    // ago -- so assert it directly rather than relying on the dead socket.
    const { server, frames, port } = await recordingServer();
    const client = new Client({
      host: '127.0.0.1', port, writeGapMs: 300,
      pollIntervalMs: 60000, log: silent,
    });
    client.start();
    await wait(150);

    client.setWhite(77, 100);   // queued, gap not yet elapsed
    client.stop();              // abandoned
    await wait(50);

    client.start();             // reconnect
    await wait(700);
    client.stop();
    server.close();

    const temps = whiteTemps(frames);
    assert.ok(
      !temps.includes(77),
      `a frame queued before stop() was flushed after restart: ${temps}`,
    );
  });

  it('drops queued frames on stop rather than writing to a dead socket', async () => {
    const { server, frames, port } = await recordingServer();
    const client = new Client({
      host: '127.0.0.1', port, writeGapMs: 300,
      pollIntervalMs: 60000, log: silent,
    });
    client.start();
    await wait(150);

    client.setWhite(50, 100);
    client.setPower(true);
    client.stop();       // before the queue can drain

    const before = frames.length;
    await wait(600);
    server.close();

    assert.strictEqual(
      frames.length, before,
      'nothing should be written after stop()',
    );
  });
});
