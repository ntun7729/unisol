import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestConnector, hasRequestFetcher } from '../src/request-connector.js';

function fakeSocket(opened = Promise.resolve()) {
  let closed = false;
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
    opened,
    closed: Promise.resolve(),
    close() { closed = true; },
    get wasClosed() { return closed; }
  };
}

test('request-aware connector prefers request.fetcher.connect', async () => {
  const requestSocket = fakeSocket();
  let globalCalls = 0;
  const seen = [];
  const request = {
    fetcher: {
      connect(address, options) {
        seen.push({ address, options });
        return requestSocket;
      }
    }
  };
  const connector = createRequestConnector(request, () => {
    globalCalls++;
    return fakeSocket();
  });

  const options = { secureTransport: 'on', allowHalfOpen: false };
  const result = await connector({ hostname: '162.158.189.134', port: 443 }, options);
  assert.equal(result, requestSocket);
  assert.equal(globalCalls, 0);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].address, { hostname: '162.158.189.134', port: 443 });
  assert.equal(seen[0].options, options);
  assert.equal(hasRequestFetcher(request), true);
});

test('request-aware connector falls back to global connect when request socket opening fails', async () => {
  const requestSocket = fakeSocket(Promise.reject(new Error('request route blocked')));
  const globalSocket = fakeSocket();
  let globalCalls = 0;
  const connector = createRequestConnector({
    fetcher: { connect: () => requestSocket }
  }, address => {
    globalCalls++;
    assert.equal(address.hostname, 'example.com');
    return globalSocket;
  });

  const result = await connector({ hostname: 'example.com', port: 443 });
  assert.equal(result, globalSocket);
  assert.equal(requestSocket.wasClosed, true);
  assert.equal(globalCalls, 1);
});

test('request-aware connector uses global connect when request fetcher is absent', async () => {
  const globalSocket = fakeSocket();
  const connector = createRequestConnector({}, () => globalSocket);
  assert.equal(await connector({ hostname: 'example.net', port: 80 }), globalSocket);
  assert.equal(hasRequestFetcher({}), false);
});

test('request-aware connector reports both request and global failures', async () => {
  const requestSocket = fakeSocket(Promise.reject(new Error('request failed')));
  const globalSocket = fakeSocket(Promise.reject(new Error('global failed')));
  const connector = createRequestConnector({ fetcher: { connect: () => requestSocket } }, () => globalSocket);

  await assert.rejects(
    () => connector({ hostname: 'blocked.example', port: 443 }),
    /request-fetcher: request failed \| global-connect: global failed/
  );
  assert.equal(requestSocket.wasClosed, true);
  assert.equal(globalSocket.wasClosed, true);
});
