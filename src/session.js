import { concatBytes } from './core.js';
import { decodeEarlyData, parseInbound } from './protocol.js';
import { closeQuietly, openOutbound } from './outbound.js';
import { CoalescingWriter, GrainSender, pipeReaderToWritable, readProtocolHead, responseReadable } from './transport.js';

export async function handleWebSocket(request, config, connector) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  try { server.accept({ allowHalfOpen: true }); } catch { server.accept(); }
  server.binaryType = 'arraybuffer';

  let input = new Uint8Array(0);
  let parsed = null;
  let remote = null;
  let upload = null;
  let stopped = false;
  let chain = Promise.resolve();

  const shutdown = reason => {
    if (stopped) return;
    stopped = true;
    try { upload?.abort(reason || new Error('session closed')); } catch {}
    closeQuietly(remote);
    try { if (server.readyState === 1) server.close(1000, 'closed'); } catch {}
  };

  const startRemote = async requestInfo => {
    validateUdp(requestInfo);
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

    if (requestInfo.responseHeader?.byteLength && server.readyState === 1) server.send(requestInfo.responseHeader);

    const sender = new GrainSender(async bytes => {
      if (server.readyState !== 1) throw new Error('WebSocket closed');
      server.send(bytes);
    }, { maxBytes: config.downloadGrainBytes, delayMs: 1 });

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
    await upload.push(bytes);
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
    headers: {
      'Content-Type': 'application/grpc',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Accel-Buffering': 'no',
      'X-Unisol-Padding': padding
    }
  });
}

function validateUdp(parsed) {
  if (!parsed.udp) return;
  if (parsed.protocol !== 'vless') throw new Error('Trojan UDP is not supported');
  if (parsed.port !== 53) throw new Error('UDP is supported only for DNS port 53');
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
