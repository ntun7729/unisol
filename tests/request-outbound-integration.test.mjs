import test from 'node:test';
import assert from 'node:assert/strict';
import { SINGLE_CF_EDGE_IP } from '../src/adaptive.js';
import { openOutbound } from '../src/outbound.js';
import { createRequestConnector } from '../src/request-connector.js';

function socketWithWrites(opened = Promise.resolve()) {
  const writes = [];
  let closed = false;
  return {
    readable: new ReadableStream(),
    writable: new WritableStream({
      write(chunk) { writes.push(new Uint8Array(chunk).slice()); }
    }),
    opened,
    closed: Promise.resolve(),
    close() { closed = true; },
    writes,
    get wasClosed() { return closed; }
  };
}

function directConfig() {
  return {
    blockPrivate: false,
    disableIpv6: false,
    mode: 'direct',
    routes: [],
    proxyIp: [],
    outbound: null,
    dialRace: 1
  };
}

test('outbound layer accepts asynchronous request-aware connector', async () => {
  const requestSocket = socketWithWrites();
  let globalCalls = 0;
  const connector = createRequestConnector({
    fetcher: {
      async connect(address) {
        assert.deepEqual(address, { hostname: 'target.example', port: 443 });
        return requestSocket;
      }
    }
  }, () => {
    globalCalls++;
    return socketWithWrites();
  });

  const result = await openOutbound({
    host: 'target.example',
    port: 443,
    initialData: new Uint8Array([1, 2, 3]),
    config: directConfig(),
    connector
  });

  assert.equal(result.route.kind, 'direct');
  assert.equal(result.socket, requestSocket);
  assert.equal(globalCalls, 0);
  assert.deepEqual([...requestSocket.writes[0]], [1, 2, 3]);
});

test('outbound gets global socket after request-bound opening rejection', async () => {
  const requestSocket = socketWithWrites(Promise.reject(new Error('request opening failed')));
  const globalSocket = socketWithWrites();
  const connector = createRequestConnector({
    fetcher: { connect: () => requestSocket }
  }, () => globalSocket);

  const result = await openOutbound({
    host: 'fallback.example',
    port: 443,
    initialData: new Uint8Array([9]),
    config: directConfig(),
    connector
  });

  assert.equal(result.socket, globalSocket);
  assert.equal(requestSocket.wasClosed, true);
  assert.deepEqual([...globalSocket.writes[0]], [9]);
});

test('single Cloudflare edge remains the SG-preferred address', () => {
  assert.equal(SINGLE_CF_EDGE_IP, '162.158.189.134');
});
