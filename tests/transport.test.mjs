import test from 'node:test';
import assert from 'node:assert/strict';
import { CoalescingWriter, GrainSender, responseReadable } from '../src/transport.js';

async function collectReadable(stream) {
  const reader = stream.getReader();
  const out = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(new Uint8Array(value));
  }
  return out;
}

test('CoalescingWriter writes queued chunks without data loss', async () => {
  const writes = [];
  const writable = new WritableStream({ write(chunk) { writes.push(new Uint8Array(chunk).slice()); } });
  const queue = new CoalescingWriter(writable, { targetBytes: 8, maxQueueBytes: 1024 });
  await Promise.all([
    queue.push(new Uint8Array([1,2])),
    queue.push(new Uint8Array([3,4])),
    queue.push(new Uint8Array([5,6,7,8]))
  ]);
  await queue.close();
  assert.deepEqual([...writes.flatMap(x => [...x])], [1,2,3,4,5,6,7,8]);
});

test('CoalescingWriter enforces queue high-water mark', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const writable = new WritableStream({ async write() { await gate; } });
  const queue = new CoalescingWriter(writable, { targetBytes: 4, maxQueueBytes: 6 });
  const first = queue.push(new Uint8Array([1,2,3,4]));
  await assert.rejects(() => queue.push(new Uint8Array([5,6,7,8,9,10,11])), /upload queue overflow/);
  release();
  await first;
  await queue.close();
});

test('GrainSender preserves ordering', async () => {
  const sent = [];
  const grain = new GrainSender(async bytes => sent.push(new Uint8Array(bytes).slice()), { maxBytes: 4, delayMs: 1 });
  grain.push(new Uint8Array([1]));
  grain.push(new Uint8Array([2,3]));
  grain.push(new Uint8Array([4,5]));
  await grain.finish();
  assert.deepEqual([...sent.flatMap(x => [...x])], [1,2,3,4,5]);
});

test('responseReadable emits protocol header before remote data', async () => {
  const remote = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([3,4]));
      controller.close();
    }
  });
  const chunks = await collectReadable(responseReadable(remote, new Uint8Array([0,0]), 32));
  assert.deepEqual(chunks.map(x => [...x]), [[0,0],[3,4]]);
});
