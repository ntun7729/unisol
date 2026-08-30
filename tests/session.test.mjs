import test from 'node:test';
import assert from 'node:assert/strict';
import { DnsFramer, frameDns, queryDns } from '../src/session.js';

function bytes(...values) { return new Uint8Array(values); }

test('DnsFramer reconstructs split VLESS UDP frames', () => {
  const framer = new DnsFramer();
  assert.deepEqual(framer.push(bytes(0,3,1)), []);
  const packets = framer.push(bytes(2,3,0,2,9,8));
  assert.deepEqual(packets.map(x => [...x]), [[1,2,3],[9,8]]);
  assert.equal(framer.pendingBytes, 0);
});

test('DnsFramer rejects oversized and zero-length frames', () => {
  assert.throws(() => new DnsFramer(4).push(bytes(0,5)), /invalid DNS frame length/);
  assert.throws(() => new DnsFramer().push(bytes(0,0)), /invalid DNS frame length/);
});

test('frameDns prefixes a two-byte network-order length', () => {
  assert.deepEqual([...frameDns(bytes(1,2,3))], [0,3,1,2,3]);
});

test('queryDns sends DNS wire format via DoH and returns response bytes', async () => {
  let seenUrl, seenInit;
  const answer = bytes(0xaa,0xbb,0xcc);
  const fakeFetch = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return new Response(answer, { status: 200, headers: { 'Content-Type': 'application/dns-message' } });
  };
  const result = await queryDns(bytes(1,2,3,4), fakeFetch);
  assert.equal(seenUrl, 'https://1.1.1.1/dns-query');
  assert.equal(seenInit.method, 'POST');
  assert.equal(seenInit.headers['Content-Type'], 'application/dns-message');
  assert.deepEqual([...new Uint8Array(seenInit.body)], [1,2,3,4]);
  assert.deepEqual([...result], [...answer]);
});

test('queryDns rejects failed upstream responses', async () => {
  await assert.rejects(() => queryDns(bytes(1), async () => new Response('no', { status: 503 })), /DNS upstream failed/);
});
