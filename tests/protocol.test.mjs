import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { concatBytes, uuidToBytes } from '../src/core.js';
import { encodeSocksAddress, parseInbound, parseTrojan, parseVless, sha224 } from '../src/protocol.js';

const UUID = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const UUID_BYTES = uuidToBytes(UUID);
const encoder = new TextEncoder();

function vlessFrame({ host = 'example.com', port = 443, command = 1, payload = new Uint8Array([1,2,3]) } = {}) {
  let address;
  if (/^\d+(?:\.\d+){3}$/.test(host)) address = new Uint8Array([1, ...host.split('.').map(Number)]);
  else {
    const name = encoder.encode(host);
    address = new Uint8Array([2, name.length, ...name]);
  }
  return concatBytes(
    new Uint8Array([0]), UUID_BYTES, new Uint8Array([0, command, port >> 8, port & 255]), address, payload
  );
}

test('VLESS TCP parses header and payload', () => {
  const result = parseVless(vlessFrame(), UUID_BYTES);
  assert.equal(result.status, 'ok');
  assert.equal(result.protocol, 'vless');
  assert.equal(result.host, 'example.com');
  assert.equal(result.port, 443);
  assert.equal(result.udp, false);
  assert.deepEqual([...result.payload], [1,2,3]);
  assert.deepEqual([...result.responseHeader], [0,0]);
});

test('VLESS supports IPv4 and DNS UDP command', () => {
  const result = parseVless(vlessFrame({ host: '1.1.1.1', port: 53, command: 2, payload: new Uint8Array([0,2,0xaa,0xbb]) }), UUID_BYTES);
  assert.equal(result.status, 'ok');
  assert.equal(result.host, '1.1.1.1');
  assert.equal(result.port, 53);
  assert.equal(result.udp, true);
});

test('VLESS rejects wrong users and reports partial data', () => {
  assert.equal(parseVless(vlessFrame().subarray(0, 10), UUID_BYTES).status, 'need-more');
  const wrong = vlessFrame().slice();
  wrong[1] ^= 0xff;
  const result = parseVless(wrong, UUID_BYTES);
  assert.equal(result.status, 'error');
  assert.match(result.error, /invalid VLESS user/);
});

test('SHA-224 implementation matches Node crypto', () => {
  for (const text of ['', 'abc', 'trojan-password', '密码-123']) {
    assert.equal(sha224(text), createHash('sha224').update(text).digest('hex'));
  }
});

test('SOCKS address encoding validates IP literals', () => {
  const v4 = encodeSocksAddress('1.2.3.4', 443);
  assert.deepEqual([...v4.subarray(0, 5)], [1,1,2,3,4]);

  const v6 = encodeSocksAddress('::ffff:192.168.1.1', 443);
  assert.equal(v6[0], 4);
  assert.deepEqual([...v6.subarray(1, 17)], [0,0,0,0,0,0,0,0,0,0,255,255,192,168,1,1]);

  const numericHostname = encodeSocksAddress('999.1.1.1', 80);
  assert.equal(numericHostname[0], 3);
  assert.throws(() => encodeSocksAddress('2001:::1', 443), /invalid IPv6 address/);
});

test('Trojan TCP parses authentication, address, port, and payload', () => {
  const password = 'super-secret';
  const auth = encoder.encode(createHash('sha224').update(password).digest('hex'));
  const address = encodeSocksAddress('target.example', 8443);
  const frame = concatBytes(
    auth,
    new Uint8Array([13,10,1]),
    address.subarray(0, address.byteLength - 2),
    address.subarray(address.byteLength - 2),
    new Uint8Array([13,10,9,8,7])
  );
  const result = parseTrojan(frame, password);
  assert.equal(result.status, 'ok');
  assert.equal(result.protocol, 'trojan');
  assert.equal(result.host, 'target.example');
  assert.equal(result.port, 8443);
  assert.deepEqual([...result.payload], [9,8,7]);
});

test('parseInbound waits for Trojan header when VLESS mismatch is partial', () => {
  const password = 'p';
  const partial = encoder.encode(createHash('sha224').update(password).digest('hex')).subarray(0, 30);
  const result = parseInbound(partial, { uuidBytes: UUID_BYTES, trojanPassword: password });
  assert.equal(result.status, 'need-more');
});
