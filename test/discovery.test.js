/**
 * Tests for the discovery reply parser. Pure string handling -- no sockets.
 */
const assert = require('node:assert');
const { describe, it } = require('node:test');

const d = require('../dist/discovery.js');

describe('discovery reply parsing', () => {
  it('parses the classic three-field reply', () => {
    const got = d.parseDiscoveryReply('192.168.1.50,AABBCCDDEEFF,AK001-ZJ2145');
    assert.deepStrictEqual(got, {
      ip: '192.168.1.50', mac: 'AABBCCDDEEFF', model: 'AK001-ZJ2145',
    });
  });

  it('parses the newer FOUR-field reply and discards the token', () => {
    const token = '0123456789abcdef0123456789abcdef';
    const got = d.parseDiscoveryReply(
      `192.168.1.50,AABBCCDDEEFF,AK001-ZJ2145,${token}`,
    );
    assert.ok(got);
    assert.strictEqual(Object.keys(got).length, 3);
    assert.strictEqual(
      JSON.stringify(got).includes(token), false,
      'the discovery token must never be surfaced -- it looks like a secret '
      + 'and nothing here needs it',
    );
  });

  it('normalises the MAC to upper case without separators', () => {
    for (const raw of ['aa:bb:cc:dd:ee:ff', 'aa-bb-cc-dd-ee-ff', 'aabbccddeeff']) {
      const got = d.parseDiscoveryReply(`192.168.1.50,${raw},MODEL`);
      assert.strictEqual(got.mac, 'AABBCCDDEEFF', `failed for ${raw}`);
    }
  });

  it('tolerates trailing whitespace and newlines', () => {
    assert.ok(d.parseDiscoveryReply('192.168.1.50,AABBCCDDEEFF,MODEL\r\n'));
  });

  it('rejects anything that is not a discovery reply', () => {
    for (const junk of [
      '', 'HF-A11ASSISTHREAD', 'hello,world', 'not-an-ip,AABBCCDDEEFF,MODEL',
      '192.168.1.50,,MODEL', '192.168.1.50,AABBCCDDEEFF,',
    ]) {
      assert.strictEqual(d.parseDiscoveryReply(junk), null, `accepted: ${JSON.stringify(junk)}`);
    }
  });

  it('exposes the documented broadcast constants', () => {
    assert.strictEqual(d.DISCOVERY_PORT, 48899);
    assert.strictEqual(d.DISCOVERY_MESSAGE, 'HF-A11ASSISTHREAD');
  });
});

describe('discover()', () => {
  it('resolves to an empty list rather than throwing when nothing answers', async () => {
    // 203.0.113.x is TEST-NET-3: guaranteed unroutable, so nothing can reply.
    const found = await d.discover(300, '203.0.113.255');
    assert.deepStrictEqual(found, []);
  });
});
