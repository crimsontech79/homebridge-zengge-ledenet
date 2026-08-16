/**
 * Colour-temperature mapping between HomeKit mireds and the device scale.
 *
 * ⚠️ The MAPPING is arithmetic and tested here. The underlying ASSUMPTION --
 * that the device scale runs 0=warm to 100=cool over roughly 2700K-6500K --
 * is unverified against hardware. These tests pin the conversion, not the
 * physics.
 */
const assert = require('node:assert');
const { describe, it } = require('node:test');

const { miredToDeviceTemp, deviceTempToMired } = require('../dist/accessory.js');

describe('colour temperature mapping', () => {
  it('maps the warm end to 0 and the cool end to 100', () => {
    assert.strictEqual(miredToDeviceTemp(370), 0);
    assert.strictEqual(miredToDeviceTemp(153), 100);
  });

  it('is monotonic: fewer mireds means a cooler, higher device value', () => {
    let prev = -1;
    for (let m = 370; m >= 153; m -= 10) {
      const t = miredToDeviceTemp(m);
      assert.ok(t >= prev, `not monotonic at ${m} mireds`);
      prev = t;
    }
  });

  it('clamps out-of-range input rather than producing a wild byte', () => {
    assert.strictEqual(miredToDeviceTemp(500), 0);
    assert.strictEqual(miredToDeviceTemp(50), 100);
    assert.strictEqual(deviceTempToMired(-20), 370);
    assert.strictEqual(deviceTempToMired(300), 153);
  });

  it('round-trips closely enough that HomeKit shows what was sent', () => {
    for (const t of [0, 25, 50, 75, 100]) {
      const back = miredToDeviceTemp(deviceTempToMired(t));
      assert.ok(Math.abs(back - t) <= 1, `${t} round-tripped to ${back}`);
    }
  });

  it('never emits a value outside the byte range the protocol expects', () => {
    for (let m = 100; m <= 600; m += 7) {
      const t = miredToDeviceTemp(m);
      assert.ok(t >= 0 && t <= 100, `${m} mireds produced ${t}`);
    }
  });
});
