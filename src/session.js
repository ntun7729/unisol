import { concatBytes } from './core.js';
import { decodeEarlyData, parseInbound } from './protocol.js';
import { closeQuietly, openOutbound } from './outbound.js';
import { CoalescingWriter, GrainSender, pipeReaderToWritable, readProtocolHead, responseReadable } from './transport.js';

const DNS_DOH = 'https://1.1.1.1/dns-query';
const DNS_MAX_PACKET = 4096;

export async function handleWebSocket(request, config, connector) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  try { server.accept({ allowHalfOpen: true }); } catch { server.accept(); }
  server.binaryType = 'arraybuffer';

  let input = new Uint8Array(0);
  let parsed = null;
  let remote = null;
  let upload = null;
  let dnsFramer = null;
  let stopped = false;
  let chain = Promise.resolve();

  const shutdown = reason => {
    if (stopped) return;
    stopped = true;
    try { upload?.abort(reason || new Error('session closed')); } catch {}
    closeQuietly(remote);
    try { if (server.readyState === 1) server.close(1000, 'closed'); } catch {}
  };

  const sendBinary = bytes => {
    if (server.readyState !== 1) throw new Error('WebSocket closed');
    server.send(bytes);
  };

  const processDnsChunk = async bytes => {
    for (const packet of dnsFramer.push(bytes)) {
      const answer = await queryDns(packet);
      sendBinary(frameDns(answer));
    }
  };

  const startRemote = async requestInfo => {
    validateUdp(requestInfo);
    if (requestInfo.responseHeader?.byteLength) sendBinary(requestInfo.responseHeader);

    if (requestInfo.udp) {
      dnsFramer = new DnsFramer();
      if (requestInfo.payload?.byteLength) await processDnsChunk(requestInfo.payload);
      return;
    }

    const result = await openOutbound({
      host: requestInfo.host,
      port: requestInfo.port,
      initialData: requestInfo.payload,
      config,
      connector
    });
    remote = result.socket;
    upload = new CoalescingWriter(remote.writable, {
      targetBytes: config.uploadCoalesceBytes,
      maxQueueBytes: config.uploadQueueBytes
    });

    const sender = new GrainSender(async bytes => sendBinary(bytes), {
      maxBytes: config.downloadGrainBytes,
      delayMs: 1
    });

    (async () => {
      const reader = remote.readable.getReader();
      try {
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.byteLength) sender.push(value);
        }
        await sender.finish();
      } catch (error) {
        if (!stopped) shutdown(error);
      } finally {
        try { reader.releaseLock(); } catch {}
        if (!stopped) shutdown();
      }
    })();
  };

  const processChunk = async chunk => {
    if (stopped) return;
    const bytes = toBytes(chunk);
    if (!parsed) {
      input = concatBytes(input, bytes);
      if (input.byteLength > 64 * 1024) throw new Error('protocol header too large');
      const result = parseInbound(input, config);
      if (result.status === 'need-more') return;
      if (result.status !== 'ok') throw new Error(result.error || 'invalid protocol request');
      parsed = result;
      input = new Uint8Array(0);
      await startRemote(parsed);
      return;
    }
    if (parsed.udp) await processDnsChunk(bytes);
    else await upload.push(bytes);
  };

  server.addEventListener('message', event => {
    chain = chain.then(() => processChunk(event.data)).catch(error => shutdown(error));
  });
  server.addEventListener('close', () => shutdown());
  server.addEventListener('error', () => shutdown(new Error('WebSocket error')));

  const early = decodeEarlyData(request.headers.get('Sec-WebSocket-Protocol'), config.maxEarlyDataBytes);
  if (early.byteLength) chain = chain.then(() => processChunk(early)).catch(error => shutdown(error));

  return new Response(null, { status: 101, webSocket: client });
}

export async function handleXhttp(request, config, connector, ctx) {
  if (!request.body) return new Response('Bad Request', { status: 400 });
  const reader = request.body.getReader();
  let head;
  try {
    head = await readProtocolHead(reader, bytes => parseInbound(bytes, config));
    validateUdp(head.parsed);
  } catch (error) {
    try { reader.releaseLock(); } catch {}
    return new Response(error?.message || 'Invalid request', { status: 400 });
  }

  if (head.parsed.udp) return dnsXhttpResponse(reader, head.parsed, ctx);

  let result;
  try {
    result = await openOutbound({
      host: head.parsed.host,
      port: head.parsed.port,
      initialData: head.parsed.payload,
      config,
      connector
    });
  } catch (error) {
    try { reader.releaseLock(); } catch {}
    return new Response(error?.message || 'Connect failed', { status: 502 });
  }

  const uploadTask = pipeReaderToWritable(reader, result.socket.writable, config)
    .catch(error => {
      closeQuietly(result.socket);
      throw error;
    });
  if (ctx?.waitUntil) ctx.waitUntil(uploadTask.catch(() => {}));

  const padding = randomPadding();
  const body = responseReadable(result.socket.readable, head.parsed.responseHeader, config.downloadGrainBytes);
  return new Response(body, {
    status: 200,
    headers: streamHeaders(padding)
  });
}

function dnsXhttpResponse(reader, parsed, ctx) {
  const framer = new DnsFramer();
  const body = new ReadableStream({
    start(controller) {
      const task = (async () => {
        try {
          if (parsed.responseHeader?.byteLength) controller.enqueue(parsed.responseHeader);
          if (parsed.payload?.byteLength) await emitDnsAnswers(framer, parsed.payload, controller);
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value?.byteLength) await emitDnsAnswers(framer, value, controller);
          }
          if (framer.pendingBytes) throw new Error('incomplete DNS frame');
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          try { reader.releaseLock(); } catch {}
        }
      })();
      if (ctx?.waitUntil) ctx.waitUntil(task.catch(() => {}));
    },
    cancel(reason) {
      try { reader.cancel(reason); } catch {}
    }
  });
  return new Response(body, { status: 200, headers: streamHeaders(randomPadding()) });
}

async function emitDnsAnswers(framer, bytes, controller) {
  for (const packet of framer.push(bytes)) controller.enqueue(frameDns(await queryDns(packet)));
}

export async function queryDns(packet, fetcher = fetch) {
  const response = await fetcher(DNS_DOH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/dns-message',
      'Accept': 'application/dns-message'
    },
    body: packet
  });
  if (!response.ok) throw new Error(`DNS upstream failed (${response.status})`);
  const answer = new Uint8Array(await response.arrayBuffer());
  if (!answer.byteLength || answer.byteLength > 65535) throw new Error('invalid DNS upstream response');
  return answer;
}

export function frameDns(packet) {
  const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
  if (!bytes.byteLength || bytes.byteLength > 65535) throw new Error('invalid DNS packet length');
  return concatBytes(new Uint8Array([bytes.byteLength >> 8, bytes.byteLength & 255]), bytes);
}

export class DnsFramer {
  constructor(maxPacketBytes = DNS_MAX_PACKET) {
    this.maxPacketBytes = maxPacketBytes;
    this.buffer = new Uint8Array(0);
  }

  get pendingBytes() { return this.buffer.byteLength; }

  push(chunk) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (bytes.byteLength) this.buffer = concatBytes(this.buffer, bytes);
    const packets = [];
    while (this.buffer.byteLength >= 2) {
      const length = (this.buffer[0] << 8) | this.buffer[1];
      if (!length || length > this.maxPacketBytes) throw new Error(`invalid DNS frame length ${length}`);
      if (this.buffer.byteLength < length + 2) break;
      packets.push(this.buffer.slice(2, length + 2));
      this.buffer = this.buffer.slice(length + 2);
    }
    if (this.buffer.byteLength > this.maxPacketBytes + 2) throw new Error('DNS frame buffer overflow');
    return packets;
  }
}

function validateUdp(parsed) {
  if (!parsed.udp) return;
  if (parsed.protocol !== 'vless') throw new Error('Trojan UDP is not supported');
  if (parsed.port !== 53) throw new Error('UDP is supported only for DNS port 53');
}

function streamHeaders(padding) {
  return {
    'Content-Type': 'application/grpc',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Accel-Buffering': 'no',
    'X-Unisol-Padding': padding
  };
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('binary WebSocket frames required');
}

function randomPadding() {
  const length = 16 + Math.floor(Math.random() * 64);
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
