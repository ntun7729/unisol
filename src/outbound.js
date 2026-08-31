import { concatBytes, isIpv6, isPrivateAddress, resolvePolicy } from './core.js';
import { discoverCloudflareEdge, noteEdgeFailure, noteEdgeSuccess } from './adaptive.js';
import { encodeSocksAddress } from './protocol.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function openOutbound({ host, port, initialData = new Uint8Array(0), config, connector, fetcher = fetch }) {
  if (!connector) throw new Error('connector is required');
  if (config.disableIpv6 && isIpv6(host)) throw new Error('IPv6 destination disabled');
  if (config.blockPrivate && isPrivateAddress(host)) throw new Error('private destination blocked');

  const policy = resolvePolicy(host, config);
  if (policy === 'block') throw new Error('destination blocked by route policy');
  if (policy === 'adaptive') {
    return openAdaptiveOutbound({ host, port, initialData, config, connector, fetcher });
  }

  const attempts = buildAttempts(host, port, config, policy);
  if (!attempts.length) throw new Error('no outbound route available');
  return openOrderedAttempts({ host, port, initialData, config, connector, attempts });
}

export function buildAttempts(host, port, config, policy = resolvePolicy(host, config)) {
  const direct = [{ kind: 'direct', host, port, label: `direct:${host}:${port}` }];
  const fallback = (config.proxyIp || []).map((item, index) => ({
    kind: 'proxyip', host: item.host, port: item.port || port, label: `proxyip#${index + 1}:${item.host}:${item.port || port}`
  }));
  const proxy = config.outbound ? [{ kind: 'proxy', host: config.outbound.host, port: config.outbound.port, label: `${config.outbound.scheme}:${config.outbound.host}:${config.outbound.port}` }] : [];

  if (policy === 'direct') return [...direct, ...fallback];
  if (policy === 'proxy-only') return proxy;
  if (policy === 'direct-first' || policy === 'adaptive') return [...direct, ...fallback, ...proxy];
  return [...proxy, ...direct, ...fallback];
}

async function openOrderedAttempts({ host, port, initialData, config, connector, attempts }) {
  const errors = [];
  for (const attempt of attempts) {
    try {
      const socket = await openAttemptSocket(attempt, { host, port, initialData, config, connector });
      return { socket, route: attempt };
    } catch (error) {
      errors.push(`${attempt.label}: ${error?.message || error}`);
    }
  }
  throw new Error(`all outbound attempts failed: ${errors.join(' | ')}`);
}

async function openAdaptiveOutbound({ host, port, initialData, config, connector, fetcher }) {
  const errors = [];
  const directAttempt = { kind: 'direct', host, port, label: `direct:${host}:${port}` };
  const hasPayload = Boolean(initialData?.byteLength);

  if (!hasPayload) {
    try {
      return { socket: await openAttemptSocket(directAttempt, { host, port, initialData, config, connector }), route: directAttempt };
    } catch (error) {
      errors.push(`${directAttempt.label}: ${error?.message || error}`);
    }

    if (config.adaptiveEdge) {
      const discovery = await discoverCloudflareEdge({ host, port, initialData, fetcher, edgeRace: config.edgeRace });
      for (const candidate of discovery.candidates.slice(0, config.edgeRace)) {
        const attempt = edgeAttempt(candidate, port);
        try {
          const socket = await openAttemptSocket(attempt, { host, port, initialData, config, connector });
          noteEdgeSuccess(candidate.host);
          return { socket, route: attempt };
        } catch (error) {
          noteEdgeFailure(candidate.host);
          errors.push(`${attempt.label}: ${error?.message || error}`);
        }
      }
    }

    return openAdaptiveTail({ host, port, initialData, config, connector, errors });
  }

  let directSession = null;
  try {
    directSession = await startResponsiveAttempt(directAttempt, {
      host, port, initialData, config, connector, timeoutMs: config.firstByteTimeoutMs
    });
  } catch (error) {
    errors.push(`${directAttempt.label}: ${error?.message || error}`);
  }

  if (directSession) {
    const early = await Promise.race([
      directSession.response
        .then(socket => ({ type: 'success', socket }))
        .catch(error => ({ type: 'failure', error })),
      delay(config.hedgeDelayMs).then(() => ({ type: 'hedge' }))
    ]);
    if (early.type === 'success') return { socket: early.socket, route: directAttempt };
    if (early.type === 'failure') {
      errors.push(`${directAttempt.label}: ${early.error?.message || early.error}`);
      directSession = null;
    }
  }

  let discovery = { eligible: false, candidates: [] };
  if (config.adaptiveEdge) {
    discovery = await discoverCloudflareEdge({ host, port, initialData, fetcher, edgeRace: config.edgeRace });
  }

  if (discovery.eligible) {
    const sessions = [];
    const contenders = [];

    if (directSession) {
      sessions.push(directSession);
      contenders.push(
        directSession.response.then(socket => ({ socket, route: directAttempt, session: directSession }))
      );
    }

    for (const candidate of discovery.candidates.slice(0, config.edgeRace)) {
      const attempt = edgeAttempt(candidate, port);
      contenders.push((async () => {
        let session;
        try {
          session = await startResponsiveAttempt(attempt, {
            host, port, initialData, config, connector, timeoutMs: config.edgeFirstByteTimeoutMs
          });
          sessions.push(session);
          const socket = await session.response;
          noteEdgeSuccess(candidate.host);
          return { socket, route: attempt, session };
        } catch (error) {
          if (error?.code !== 'SUPERSEDED') noteEdgeFailure(candidate.host);
          throw new Error(`${attempt.label}: ${error?.message || error}`);
        }
      })());
    }

    if (contenders.length) {
      try {
        const winner = await Promise.any(contenders);
        for (const session of sessions) if (session !== winner.session) session.cancel('superseded');
        return { socket: winner.socket, route: winner.route, adaptive: { application: discovery.application, routeHost: discovery.routeHost } };
      } catch (aggregate) {
        for (const session of sessions) session.cancel('superseded');
        for (const error of aggregate?.errors || []) errors.push(error?.message || String(error));
        directSession = null;
      }
    }
  } else if (directSession) {
    try {
      const socket = await directSession.response;
      return { socket, route: directAttempt };
    } catch (error) {
      errors.push(`${directAttempt.label}: ${error?.message || error}`);
      directSession = null;
    }
  }

  if (directSession) directSession.cancel('superseded');
  return openAdaptiveTail({ host, port, initialData, config, connector, errors });
}

async function openAdaptiveTail({ host, port, initialData, config, connector, errors }) {
  for (let index = 0; index < (config.proxyIp || []).length; index++) {
    const item = config.proxyIp[index];
    const attempt = { kind: 'proxyip', host: item.host, port: item.port || port, label: `proxyip#${index + 1}:${item.host}:${item.port || port}` };
    try {
      const socket = initialData?.byteLength
        ? await openResponsiveOnce(attempt, { host, port, initialData, config, connector, timeoutMs: config.edgeFirstByteTimeoutMs })
        : await openAttemptSocket(attempt, { host, port, initialData, config, connector });
      return { socket, route: attempt };
    } catch (error) {
      errors.push(`${attempt.label}: ${error?.message || error}`);
    }
  }

  if (config.outbound) {
    const attempt = { kind: 'proxy', host: config.outbound.host, port: config.outbound.port, label: `${config.outbound.scheme}:${config.outbound.host}:${config.outbound.port}` };
    try {
      const socket = initialData?.byteLength
        ? await openResponsiveOnce(attempt, { host, port, initialData, config, connector, timeoutMs: config.firstByteTimeoutMs })
        : await openAttemptSocket(attempt, { host, port, initialData, config, connector });
      return { socket, route: attempt };
    } catch (error) {
      errors.push(`${attempt.label}: ${error?.message || error}`);
    }
  }

  throw new Error(`all adaptive outbound attempts failed: ${errors.join(' | ')}`);
}

function edgeAttempt(candidate, port) {
  return { kind: 'edge', host: candidate.host, port, label: `edge-${candidate.source}:${candidate.host}:${port}` };
}

async function openResponsiveOnce(attempt, options) {
  const session = await startResponsiveAttempt(attempt, options);
  return session.response;
}

async function startResponsiveAttempt(attempt, { host, port, initialData, config, connector, timeoutMs }) {
  const socket = await openAttemptSocket(attempt, { host, port, initialData, config, connector });
  const gate = firstByteGate(socket, timeoutMs);
  return {
    attempt,
    socket,
    response: gate.response,
    cancel: gate.cancel
  };
}

function firstByteGate(socket, timeoutMs) {
  const reader = socket.readable.getReader();
  let settled = false;
  let resultSocket = null;
  let rejectResponse;
  let timer;

  const response = new Promise((resolve, reject) => {
    rejectResponse = reject;
    timer = setTimeout(() => fail(new Error(`first-byte timeout after ${timeoutMs}ms`), reject), timeoutMs);
    reader.read().then(({ value, done }) => {
      if (settled) return;
      if (done || !value?.byteLength) {
        fail(new Error('remote closed before first byte'), reject);
        return;
      }
      settled = true;
      clearTimeout(timer);
      try { reader.releaseLock(); } catch {}
      resultSocket = wrapReadablePrefix(socket, value);
      resolve(resultSocket);
    }).catch(error => fail(error, reject));
  });

  function fail(error, reject = rejectResponse) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { reader.cancel(error).catch(() => {}); } catch {}
    try { reader.releaseLock(); } catch {}
    closeQuietly(socket);
    reject?.(error);
  }

  function cancel(reason = 'cancelled') {
    if (settled) {
      closeQuietly(resultSocket || socket);
      return;
    }
    const error = new Error(reason);
    if (reason === 'superseded') error.code = 'SUPERSEDED';
    fail(error);
  }

  return { response, cancel };
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

async function openAttemptSocket(attempt, { host, port, initialData, config, connector }) {
  let socket;
  try {
    if (attempt.kind === 'proxy') {
      return await connectViaProxy(connector, config.outbound, host, port, initialData);
    }
    const race = attempt.kind === 'direct' ? config.dialRace : 1;
    socket = await connectDirect(connector, attempt.host, attempt.port, race);
    await writeInitial(socket, initialData);
    return socket;
  } catch (error) {
    closeQuietly(socket);
    throw error;
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
      'User-Agent: Unisol/2'
    ];
    if (proxy.username) lines.push(`Proxy-Authorization: Basic ${base64Utf8(`${proxy.username}:${proxy.password || ''}`)}`);
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function base64Utf8(value) {
  const bytes = encoder.encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
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
  let reader;
  const readable = new ReadableStream({
    async pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(prefix);
        return;
      }
      if (!reader) reader = original.getReader();
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      try { reader?.cancel(reason); } catch {}
    }
  });
  return {
    readable,
    writable: socket.writable,
    opened: socket.opened,
    closed: socket.closed,
    close: () => socket.close?.()
  };
}
