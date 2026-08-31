import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttempts, formatAuthority, httpConnect, openOutbound, socks5Connect } from '../src/outbound.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function scriptedSocket(onWrite) {
  let controller;
  const reads = new ReadableStream({ start(c) { controller = c; } });
  const writes = [];
  const writable = new WritableStream({
    async write(chunk) {
      const copy = new Uint8Array(chunk).slice();
      writes.push(copy);
      const responses = await onWrite(copy, writes.length);
      for (const response of responses || []) controller.enqueue(response);
    }
  });
  let closed = false;
  return {
    readable: reads,
    writable,
    opened: Promise.resolve({ remoteAddress: 'fake' }),
    closed: Promise.resolve(),
    close() { closed = true; try { controller.close(); } catch {} },
    push(bytes) { if (!closed) controller.enqueue(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); },
    writes,
    get wasClosed() { return closed; }
  };
}

async function readOne(stream) {
  const reader = stream.getReader();
  const result = await reader.read();
  reader.releaseLock();
  return result.value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function adaptiveConfig(overrides = {}) {
  return {
    blockPrivate: false,
    disableIpv6: false,
    mode: 'adaptive',
    routes: [],
    proxyIp: [],
    outbound: null,
    dialRace: 1,
    adaptiveEdge: true,
    hedgeDelayMs: 5,
    firstByteTimeoutMs: 60,
    edgeFirstByteTimeoutMs: 40,
    edgeRace: 1,
    ...overrides
  };
}

function dnsFetcher(map, counter = null) {
  return async url => {
    if (counter) counter.count++;
    const parsed = new URL(url);
    const name = parsed.searchParams.get('name');
    const addresses = map[name] || [];
    return new Response(JSON.stringify({
      Status: 0,
      Answer: addresses.map(address => ({ name: `${name}.`, type: 1, TTL: 60, data: address }))
    }), { status: 200, headers: { 'Content-Type': 'application/dns-json' } });
  };
}

test('buildAttempts obeys outbound mode order', () => {
  const config = {
    mode: 'proxy-first',
    routes: [],
    outbound: { scheme: 'socks5', host: 'p.example', port: 1080 },
    proxyIp: [{ host: 'fallback.example', port: 443 }]
  };
  assert.deepEqual(buildAttempts('target.example', 443, config).map(x => x.kind), ['proxy','direct','proxyip']);
  assert.deepEqual(buildAttempts('target.example', 443, config, 'direct-first').map(x => x.kind), ['direct','proxyip','proxy']);
  assert.deepEqual(buildAttempts('target.example', 443, config, 'adaptive').map(x => x.kind), ['direct','proxyip','proxy']);
  assert.deepEqual(buildAttempts('target.example', 443, config, 'proxy-only').map(x => x.kind), ['proxy']);
  assert.deepEqual(buildAttempts('target.example', 443, config, 'direct').map(x => x.kind), ['direct','proxyip']);
});

test('SOCKS5 handshake accepts segmented replies and preserves leftover bytes', async () => {
  const socket = scriptedSocket((chunk, n) => {
    if (n === 1) return [new Uint8Array([5]), new Uint8Array([0])];
    if (n === 2) return [new Uint8Array([5,0,0]), new Uint8Array([1,127,0,0,1,0x1f,0x90,9,8])];
    return [];
  });
  const connector = () => socket;
  const tunneled = await socks5Connect(connector, {
    scheme: 'socks5', host: 'proxy.example', port: 1080, username: '', password: ''
  }, 'target.example', 443, new Uint8Array([1,2,3]));

  assert.deepEqual([...socket.writes[0]], [5,1,0]);
  assert.equal(socket.writes[1][0], 5);
  assert.deepEqual([...socket.writes[2]], [1,2,3]);
  assert.deepEqual([...(await readOne(tunneled.readable))], [9,8]);
  assert.equal(tunneled.writable, socket.writable);
  assert.equal(typeof tunneled.close, 'function');
});

test('SOCKS5 username/password authentication is sent when requested', async () => {
  const socket = scriptedSocket((chunk, n) => {
    if (n === 1) return [new Uint8Array([5,2])];
    if (n === 2) return [new Uint8Array([1,0])];
    if (n === 3) return [new Uint8Array([5,0,0,1,127,0,0,1,0,1])];
    return [];
  });
  await socks5Connect(() => socket, {
    scheme: 'socks5', host: 'proxy.example', port: 1080, username: 'u', password: 'pw'
  }, 'target.example', 443);
  assert.deepEqual([...socket.writes[0]], [5,2,0,2]);
  assert.deepEqual([...socket.writes[1]], [1,1,117,2,112,119]);
});

test('HTTP CONNECT sends authority, auth, TLS option, and preserves prefix', async () => {
  let options;
  const socket = scriptedSocket((chunk, n) => {
    if (n === 1) return [encoder.encode('HTTP/1.1 200 Connection Established\r\nX-Test: yes\r\n\r\n'), new Uint8Array([7,6])];
    return [];
  });
  const connector = (_address, opts) => { options = opts; return socket; };
  const tunneled = await httpConnect(connector, {
    scheme: 'https', host: 'proxy.example', port: 443, username: 'user', password: 'pass'
  }, '2606:4700::1111', 8443, new Uint8Array([4,5]));
  const request = decoder.decode(socket.writes[0]);
  assert.match(request, /^CONNECT \[2606:4700::1111\]:8443 HTTP\/1\.1/m);
  assert.match(request, /Proxy-Authorization: Basic dXNlcjpwYXNz/);
  assert.equal(options.secureTransport, 'on');
  assert.deepEqual([...socket.writes[1]], [4,5]);
  assert.deepEqual([...(await readOne(tunneled.readable))], [7,6]);
});

test('openOutbound blocks private and disabled IPv6 destinations before dialing', async () => {
  const config = { blockPrivate: true, disableIpv6: false, mode: 'direct', routes: [], proxyIp: [], dialRace: 1 };
  await assert.rejects(() => openOutbound({ host: '127.0.0.1', port: 80, config, connector: () => { throw new Error('must not dial'); } }), /private destination blocked/);
  await assert.rejects(() => openOutbound({ host: '::1', port: 80, config: { ...config, blockPrivate: false, disableIpv6: true }, connector: () => { throw new Error('must not dial'); } }), /IPv6 destination disabled/);
});

test('openOutbound closes a failed direct socket before trying fallback', async () => {
  const bad = scriptedSocket(async () => { throw new Error('write failed'); });
  const good = scriptedSocket(async () => []);
  const addresses = [];
  const connector = address => {
    addresses.push(address);
    return addresses.length === 1 ? bad : good;
  };
  const config = {
    blockPrivate: false,
    disableIpv6: false,
    mode: 'direct',
    routes: [],
    proxyIp: [{ host: 'fallback.example', port: 443 }],
    outbound: null,
    dialRace: 1
  };
  const result = await openOutbound({
    host: 'target.example',
    port: 443,
    initialData: new Uint8Array([1,2,3]),
    config,
    connector
  });
  assert.equal(bad.wasClosed, true);
  assert.equal(result.route.host, 'fallback.example');
  assert.equal(result.route.kind, 'proxyip');
  assert.deepEqual([...good.writes[0]], [1,2,3]);
});

test('adaptive mode returns fast direct traffic without a DNS classification request', async () => {
  const direct = scriptedSocket((_chunk, n) => n === 1 ? [new Uint8Array([9,8,7])] : []);
  const counter = { count: 0 };
  const result = await openOutbound({
    host: 'fast.example',
    port: 443,
    initialData: encoder.encode('GET / HTTP/1.1\r\nHost: fast.example\r\n\r\n'),
    config: adaptiveConfig({ hedgeDelayMs: 30 }),
    connector: () => direct,
    fetcher: dnsFetcher({}, counter)
  });
  assert.equal(result.route.kind, 'direct');
  assert.equal(counter.count, 0);
  assert.deepEqual([...(await readOne(result.socket.readable))], [9,8,7]);
});

test('adaptive mode hedges a stalled Cloudflare destination through dynamically discovered edge IPs', async () => {
  const direct = scriptedSocket(async () => []);
  const edge = scriptedSocket((_chunk, n) => n === 1 ? [new Uint8Array([7,7])] : []);
  const addresses = [];
  const connector = address => {
    addresses.push(address.hostname);
    return address.hostname === 'target.example' ? direct : edge;
  };
  const result = await openOutbound({
    host: 'target.example',
    port: 443,
    initialData: encoder.encode('GET / HTTP/1.1\r\nHost: target.example\r\n\r\n'),
    config: adaptiveConfig(),
    connector,
    fetcher: dnsFetcher({
      'target.example': ['104.18.22.10'],
      'www.cloudflare.com': ['104.16.123.96']
    })
  });
  assert.equal(result.route.kind, 'edge');
  assert.notEqual(result.route.host, 'target.example');
  assert.equal(direct.wasClosed, true);
  assert.deepEqual([...(await readOne(result.socket.readable))], [7,7]);
  assert.ok(addresses.some(address => /^104\./.test(address)));
});

test('adaptive mode closes an edge contender that finishes opening after direct already wins', async () => {
  const direct = scriptedSocket(async () => []);
  const edge = scriptedSocket(async () => []);
  edge.opened = sleep(30).then(() => ({ remoteAddress: 'edge' }));
  const connector = address => address.hostname === 'target.example' ? direct : edge;

  const resultPromise = openOutbound({
    host: 'target.example',
    port: 443,
    initialData: encoder.encode('GET / HTTP/1.1\r\nHost: target.example\r\n\r\n'),
    config: adaptiveConfig({ hedgeDelayMs: 2, firstByteTimeoutMs: 120, edgeFirstByteTimeoutMs: 200 }),
    connector,
    fetcher: dnsFetcher({
      'target.example': ['104.18.22.10'],
      'www.cloudflare.com': ['104.16.123.96']
    })
  });

  setTimeout(() => direct.push(new Uint8Array([3,2,1])), 12);
  const result = await resultPromise;
  assert.equal(result.route.kind, 'direct');
  assert.deepEqual([...(await readOne(result.socket.readable))], [3,2,1]);
  await sleep(45);
  assert.equal(edge.wasClosed, true);
});

test('adaptive mode skips edge bridging for non-Cloudflare DNS and falls back to configured ProxyIP', async () => {
  const direct = scriptedSocket(async () => []);
  const fallback = scriptedSocket((_chunk, n) => n === 1 ? [new Uint8Array([5])] : []);
  const addresses = [];
  const connector = address => {
    addresses.push(address.hostname);
    return address.hostname === 'ordinary.example' ? direct : fallback;
  };
  const result = await openOutbound({
    host: 'ordinary.example',
    port: 443,
    initialData: encoder.encode('GET / HTTP/1.1\r\nHost: ordinary.example\r\n\r\n'),
    config: adaptiveConfig({ proxyIp: [{ host: 'fallback.example', port: 443 }], firstByteTimeoutMs: 25 }),
    connector,
    fetcher: dnsFetcher({ 'ordinary.example': ['93.184.216.34'] })
  });
  assert.equal(result.route.kind, 'proxyip');
  assert.equal(result.route.host, 'fallback.example');
  assert.deepEqual([...(await readOne(result.socket.readable))], [5]);
  assert.deepEqual(addresses, ['ordinary.example', 'fallback.example']);
});

test('IPv6 HTTP CONNECT authority is bracketed', () => {
  assert.equal(formatAuthority('2606:4700::1111', 443), '[2606:4700::1111]:443');
  assert.equal(formatAuthority('example.com', 443), 'example.com:443');
});
