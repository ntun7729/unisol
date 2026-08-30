import { concatBytes, isIpv6, isPrivateAddress, resolvePolicy } from './core.js';
import { encodeSocksAddress } from './protocol.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function openOutbound({ host, port, initialData = new Uint8Array(0), config, connector }) {
  if (!connector) throw new Error('connector is required');
  if (config.disableIpv6 && isIpv6(host)) throw new Error('IPv6 destination disabled');
  if (config.blockPrivate && isPrivateAddress(host)) throw new Error('private destination blocked');

  const policy = resolvePolicy(host, config);
  if (policy === 'block') throw new Error('destination blocked by route policy');
  const attempts = buildAttempts(host, port, config, policy);
  if (!attempts.length) throw new Error('no outbound route available');

  const errors = [];
  for (const attempt of attempts) {
    try {
      let socket;
      if (attempt.kind === 'proxy') {
        socket = await connectViaProxy(connector, config.outbound, host, port, initialData);
      } else {
        socket = await connectDirect(connector, attempt.host, attempt.port, config.dialRace);
        await writeInitial(socket, initialData);
      }
      return { socket, route: attempt };
    } catch (error) {
      errors.push(`${attempt.label}: ${error?.message || error}`);
    }
  }
  throw new Error(`all outbound attempts failed: ${errors.join(' | ')}`);
}

export function buildAttempts(host, port, config, policy = resolvePolicy(host, config)) {
  const direct = [{ kind: 'direct', host, port, label: `direct:${host}:${port}` }];
  const fallback = (config.proxyIp || []).map((item, index) => ({
    kind: 'direct', host: item.host, port: item.port || port, label: `proxyip#${index + 1}:${item.host}:${item.port || port}`
  }));
  const proxy = config.outbound ? [{ kind: 'proxy', host: config.outbound.host, port: config.outbound.port, label: `${config.outbound.scheme}:${config.outbound.host}:${config.outbound.port}` }] : [];

  if (policy === 'direct') return [...direct, ...fallback];
  if (policy === 'proxy-only') return proxy;
  if (policy === 'direct-first') return [...direct, ...fallback, ...proxy];
  return [...proxy, ...direct, ...fallback];
}

export async function connectDirect(connector, host, port, raceCount = 1) {
  const count = Math.max(1, Math.min(4, Number(raceCount) || 1));
  if (count === 1) return openSocket(connector, host, port, false);
  const jobs = Array.from({ length: count }, () => openSocket(connector, host, port, false));
  let winner;
  try {
    winner = await Promise.any(jobs);
    return winner;
  } finally {
    if (winner) {
      for (const job of jobs) {
        job.then(socket => {
          if (socket !== winner) closeQuietly(socket);
        }).catch(() => {});
      }
    }
  }
}

async function openSocket(connector, host, port, secure) {
  const address = { hostname: host, port };
  const socket = secure
    ? connector(address, { secureTransport: 'on', allowHalfOpen: false })
    : connector(address);
  if (!socket) throw new Error('socket creation failed');
  if (socket.opened) await socket.opened;
  return socket;
}

export async function connectViaProxy(connector, proxy, host, port, initialData) {
  if (!proxy) throw new Error('proxy is not configured');
  if (proxy.scheme === 'socks5') return socks5Connect(connector, proxy, host, port, initialData);
  if (proxy.scheme === 'http' || proxy.scheme === 'https') return httpConnect(connector, proxy, host, port, initialData);
  throw new Error(`unsupported proxy scheme ${proxy.scheme}`);
}

export async function socks5Connect(connector, proxy, host, port, initialData = new Uint8Array(0)) {
  const socket = await openSocket(connector, proxy.host, proxy.port, false);
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const buffered = new BufferedReader(reader);
  try {
    await writer.write(new Uint8Array(proxy.username ? [5, 2, 0, 2] : [5, 1, 0]));
    let response = await buffered.readExact(2);
    if (response[0] !== 5 || response[1] === 0xff) throw new Error('SOCKS5 has no acceptable auth method');
    if (response[1] === 2) {
      if (!proxy.username) throw new Error('SOCKS5 authentication required');
      const user = encoder.encode(proxy.username);
      const pass = encoder.encode(proxy.password || '');
      if (user.byteLength > 255 || pass.byteLength > 255) throw new Error('SOCKS5 credentials too long');
      await writer.write(concatBytes(new Uint8Array([1, user.byteLength]), user, new Uint8Array([pass.byteLength]), pass));
      response = await buffered.readExact(2);
      if (response[0] !== 1 || response[1] !== 0) throw new Error('SOCKS5 authentication failed');
    } else if (response[1] !== 0) {
      throw new Error(`SOCKS5 unsupported auth method ${response[1]}`);
    }

    await writer.write(concatBytes(new Uint8Array([5, 1, 0]), encodeSocksAddress(host, port)));
    const head = await buffered.readExact(4);
    if (head[0] !== 5 || head[1] !== 0) throw new Error(`SOCKS5 connect failed (${head[1]})`);
    if (head[3] === 1) await buffered.readExact(4 + 2);
    else if (head[3] === 4) await buffered.readExact(16 + 2);
    else if (head[3] === 3) {
      const len = (await buffered.readExact(1))[0];
      await buffered.readExact(len + 2);
    } else throw new Error('SOCKS5 invalid bind address type');

    if (initialData?.byteLength) await writer.write(initialData);
    const prefix = buffered.takeRemainder();
    return prefix.byteLength ? wrapReadablePrefix(socket, prefix) : socket;
  } catch (error) {
    closeQuietly(socket);
    throw error;
  } finally {
    try { writer.releaseLock(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

export async function httpConnect(connector, proxy, host, port, initialData = new Uint8Array(0)) {
  const secure = proxy.scheme === 'https';
  const socket = await openSocket(connector, proxy.host, proxy.port, secure);
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const buffered = new BufferedReader(reader);
  try {
    const authority = formatAuthority(host, port);
    const lines = [
      `CONNECT ${authority} HTTP/1.1`,
      `Host: ${authority}`,
      'Proxy-Connection: keep-alive',
      'User-Agent: Unisol/1'
    ];
    if (proxy.username) lines.push(`Proxy-Authorization: Basic ${btoa(`${proxy.username}:${proxy.password || ''}`)}`);
    lines.push('', '');
    await writer.write(encoder.encode(lines.join('\r\n')));
    const header = await buffered.readUntil(encoder.encode('\r\n\r\n'), 16 * 1024);
    const statusLine = decoder.decode(header).split('\r\n', 1)[0] || '';
    const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i.exec(statusLine);
    if (!match || Number(match[1]) < 200 || Number(match[1]) >= 300) throw new Error(`HTTP CONNECT rejected: ${statusLine || 'invalid response'}`);
    if (initialData?.byteLength) await writer.write(initialData);
    const prefix = buffered.takeRemainder();
    return prefix.byteLength ? wrapReadablePrefix(socket, prefix) : socket;
  } catch (error) {
    closeQuietly(socket);
    throw error;
  } finally {
    try { writer.releaseLock(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

async function writeInitial(socket, initialData) {
  if (!initialData?.byteLength) return;
  const writer = socket.writable.getWriter();
  try { await writer.write(initialData); }
  finally { try { writer.releaseLock(); } catch {} }
}

export function formatAuthority(host, port) {
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

export function closeQuietly(socket) {
  try { socket?.close?.(); } catch {}
}

export class BufferedReader {
  constructor(reader) {
    this.reader = reader;
    this.buffer = new Uint8Array(0);
  }

  async fill(length) {
    while (this.buffer.byteLength < length) {
      const { value, done } = await this.reader.read();
      if (done || !value) throw new Error('proxy connection closed during handshake');
      this.buffer = concatBytes(this.buffer, value);
    }
  }

  async readExact(length) {
    await this.fill(length);
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }

  async readUntil(marker, maxBytes) {
    while (true) {
      const index = indexOfBytes(this.buffer, marker);
      if (index >= 0) {
        const end = index + marker.byteLength;
        const out = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        return out;
      }
      if (this.buffer.byteLength >= maxBytes) throw new Error('proxy response header too large');
      const { value, done } = await this.reader.read();
      if (done || !value) throw new Error('proxy connection closed during handshake');
      this.buffer = concatBytes(this.buffer, value);
    }
  }

  takeRemainder() {
    const out = this.buffer;
    this.buffer = new Uint8Array(0);
    return out;
  }
}

function indexOfBytes(haystack, needle) {
  outer: for (let i = 0; i <= haystack.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function wrapReadablePrefix(socket, prefix) {
  const original = socket.readable;
  let sent = false;
  const readable = new ReadableStream({
    async pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(prefix);
        return;
      }
      if (!this.reader) this.reader = original.getReader();
      const { value, done } = await this.reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      try { this.reader?.cancel(reason); } catch {}
    }
  });
  return { ...socket, readable };
}
