import { concatBytes } from './core.js';

export class CoalescingWriter {
  constructor(writable, { targetBytes = 16 * 1024, maxQueueBytes = 4 * 1024 * 1024 } = {}) {
    this.writer = writable.getWriter();
    this.targetBytes = targetBytes;
    this.maxQueueBytes = maxQueueBytes;
    this.queue = [];
    this.queueBytes = 0;
    this.running = false;
    this.closed = false;
    this.error = null;
    this.waiters = [];
  }

  async push(chunk) {
    if (this.error) throw this.error;
    if (this.closed) throw new Error('writer is closed');
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (!bytes.byteLength) return;
    if (this.queueBytes + bytes.byteLength > this.maxQueueBytes) throw new Error('upload queue overflow');
    this.queue.push(bytes.slice());
    this.queueBytes += bytes.byteLength;
    if (!this.running) this.drain();
    await this.waitForBelow(Math.floor(this.maxQueueBytes / 2));
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        let total = 0;
        const batch = [];
        while (this.queue.length && (total < this.targetBytes || batch.length === 0)) {
          const next = this.queue[0];
          if (batch.length && total + next.byteLength > this.targetBytes * 2) break;
          this.queue.shift();
          this.queueBytes -= next.byteLength;
          batch.push(next);
          total += next.byteLength;
          if (next.byteLength >= this.targetBytes) break;
        }
        const payload = batch.length === 1 ? batch[0] : concatBytes(...batch);
        await this.writer.write(payload);
        this.notifyWaiters();
      }
    } catch (error) {
      this.error = error;
      this.queue = [];
      this.queueBytes = 0;
      this.notifyWaiters(error);
    } finally {
      this.running = false;
      this.notifyWaiters(this.error);
    }
  }

  waitForBelow(limit) {
    if (this.error) return Promise.reject(this.error);
    if (this.queueBytes <= limit) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ limit, resolve, reject }));
  }

  notifyWaiters(error = null) {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      if (error) waiter.reject(error);
      else if (this.queueBytes <= waiter.limit) waiter.resolve();
      else this.waiters.push(waiter);
    }
  }

  async flush() {
    while ((this.running || this.queue.length) && !this.error) {
      if (!this.running && this.queue.length) this.drain();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (this.error) throw this.error;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    try { await this.writer.close(); } finally { try { this.writer.releaseLock(); } catch {} }
  }

  abort(reason) {
    this.closed = true;
    this.queue = [];
    this.queueBytes = 0;
    this.notifyWaiters(reason instanceof Error ? reason : new Error(String(reason || 'aborted')));
    try { this.writer.abort(reason); } catch {}
    try { this.writer.releaseLock(); } catch {}
  }
}

export class GrainSender {
  constructor(send, { maxBytes = 32 * 1024, delayMs = 1 } = {}) {
    this.send = send;
    this.maxBytes = maxBytes;
    this.delayMs = delayMs;
    this.parts = [];
    this.bytes = 0;
    this.timer = null;
    this.chain = Promise.resolve();
    this.error = null;
  }

  push(chunk) {
    if (this.error) throw this.error;
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (!bytes.byteLength) return;
    if (bytes.byteLength >= this.maxBytes && this.bytes === 0) {
      this.enqueueSend(bytes);
      return;
    }
    if (this.bytes + bytes.byteLength > this.maxBytes) this.flush();
    this.parts.push(bytes.slice());
    this.bytes += bytes.byteLength;
    if (this.bytes >= this.maxBytes) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  enqueueSend(bytes) {
    this.chain = this.chain.then(() => this.send(bytes)).catch(error => {
      this.error = error;
      throw error;
    });
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.bytes) return;
    const payload = this.parts.length === 1 ? this.parts[0] : concatBytes(...this.parts);
    this.parts = [];
    this.bytes = 0;
    this.enqueueSend(payload);
  }

  async finish() {
    this.flush();
    await this.chain;
    if (this.error) throw this.error;
  }
}

export async function readProtocolHead(reader, parse, maxBytes = 64 * 1024) {
  let buffer = new Uint8Array(0);
  while (buffer.byteLength <= maxBytes) {
    const parsed = parse(buffer);
    if (parsed.status === 'ok') return { parsed, reader };
    if (parsed.status === 'error') throw new Error(parsed.error || 'invalid protocol request');
    const { value, done } = await reader.read();
    if (done) throw new Error('request ended before protocol header completed');
    if (!value?.byteLength) continue;
    buffer = concatBytes(buffer, value);
  }
  throw new Error('protocol header too large');
}

export function responseReadable(readable, responseHeader = null, grainBytes = 32 * 1024) {
  let header = responseHeader?.byteLength ? responseHeader : null;
  const reader = readable.getReader();
  let grain = new Uint8Array(0);
  return new ReadableStream({
    async pull(controller) {
      try {
        if (header) {
          controller.enqueue(header);
          header = null;
          return;
        }
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            if (grain.byteLength) controller.enqueue(grain);
            controller.close();
            return;
          }
          if (!value?.byteLength) continue;
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
          if (bytes.byteLength >= grainBytes && !grain.byteLength) {
            controller.enqueue(bytes);
            return;
          }
          grain = concatBytes(grain, bytes);
          if (grain.byteLength >= grainBytes) {
            const out = grain;
            grain = new Uint8Array(0);
            controller.enqueue(out);
            return;
          }
          // Do not hold a small tail indefinitely waiting for a future remote packet.
          const out = grain;
          grain = new Uint8Array(0);
          controller.enqueue(out);
          return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      try { reader.cancel(reason); } catch {}
    }
  });
}

export async function pipeReaderToWritable(reader, writable, config) {
  const queue = new CoalescingWriter(writable, {
    targetBytes: config.uploadCoalesceBytes,
    maxQueueBytes: config.uploadQueueBytes
  });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.byteLength) await queue.push(value);
    }
    await queue.close();
  } catch (error) {
    queue.abort(error);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}
