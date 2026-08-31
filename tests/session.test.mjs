import test from 'node:test';
import assert from 'node:assert/strict';
import { DnsFramer, frameDns, queryDns, readInitialApplicationData, shouldDeferAdaptiveTcp } from '../src/session.js';

function bytes(...values) { return new Uint8Array(values); }

function adaptiveConfig(overrides = {}) {
  return {
    mode: 'adaptive',
    routes: [],
    adaptiveEdge: true,
    ...overrides
  };
}

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

test('adaptive web TCP waits for application bytes when protocol header has no payload', () => {
  const parsed = { host: 'site.example', port: 443, udp: false, payload: new Uint8Array(0) };
  assert.equal(shouldDeferAdaptiveTcp(parsed, adaptiveConfig()), true);
  assert.equal(shouldDeferAdaptiveTcp({ ...parsed, port: 22 }, adaptiveConfig()), false);
  assert.equal(shouldDeferAdaptiveTcp({ ...parsed, payload: bytes(1) }, adaptiveConfig()), false);
  assert.equal(shouldDeferAdaptiveTcp(parsed, adaptiveConfig({ adaptiveEdge: false })), false);
  assert.equal(shouldDeferAdaptiveTcp(parsed, adaptiveConfig({ mode: 'direct' })), false);
});

test('route-specific adaptive policy can defer even when global mode is direct', () => {
  const parsed = { host: 'cf.example', port: 443, udp: false, payload: new Uint8Array(0) };
  const config = adaptiveConfig({
    mode: 'direct',
    routes: [{ pattern: 'cf.example', policy: 'adaptive' }]
  });
  assert.equal(shouldDeferAdaptiveTcp(parsed, config), true);
});

test('readInitialApplicationData consumes the next non-empty streamed chunk for adaptive XHTTP', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(0));
      controller.enqueue(bytes(0x16, 0x03, 0x01, 0x00, 0x05));
      controller.enqueue(bytes(9, 8));
      controller.close();
    }
  });
  const reader = stream.getReader();
  const parsed = { host: 'site.example', port: 443, udp: false, payload: new Uint8Array(0) };
  const first = await readInitialApplicationData(reader, parsed, adaptiveConfig());
  assert.deepEqual([...first], [0x16, 0x03, 0x01, 0x00, 0x05]);
  const remaining = await reader.read();
  assert.deepEqual([...remaining.value], [9, 8]);
  reader.releaseLock();
});
