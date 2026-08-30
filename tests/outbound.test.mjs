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

test('buildAttempts obeys outbound mode order', () => {
  const config = {
    mode: 'proxy-first',
    routes: [],
    outbound: { scheme: 'socks5', host: 'p.example', port: 1080 },
    proxyIp: [{ host: 'fallback.example', port: 443 }]
  };
  assert.deepEqual(buildAttempts('target.example', 443, config).map(x => x.kind), ['proxy','direct','direct']);
  assert.deepEqual(buildAttempts('target.example', 443, config, 'direct-first').map(x => x.kind), ['direct','direct','proxy']);
  assert.deepEqual(buildAttempts('target.example', 443, config, 'proxy-only').map(x => x.kind), ['proxy']);
  assert.deepEqual(buildAttempts('target.example', 443, config, 'direct').map(x => x.kind), ['direct','direct']);
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

test('IPv6 HTTP CONNECT authority is bracketed', () => {
  assert.equal(formatAuthority('2606:4700::1111', 443), '[2606:4700::1111]:443');
  assert.equal(formatAuthority('example.com', 443), 'example.com:443');
});
