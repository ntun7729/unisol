export const VERSION = '0.2.0';

export const DEFAULTS = Object.freeze({
  mode: 'adaptive',
  dialRace: 2,
  hedgeDelayMs: 900,
  firstByteTimeoutMs: 5000,
  edgeFirstByteTimeoutMs: 3000,
  edgeRace: 2,
  adaptiveEdge: true,
  maxEarlyDataBytes: 8192,
  uploadCoalesceBytes: 16 * 1024,
  uploadQueueBytes: 4 * 1024 * 1024,
  downloadGrainBytes: 32 * 1024,
  enableWs: true,
  enableXhttp: true,
  blockPrivate: true,
  disableIpv6: false,
  allowPathOverride: false,
  rootMode: 'cafe'
});

export function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(text)) return false;
  return fallback;
}

export function intValue(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function normalizeUuid(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) return '';
  return text;
}

export function uuidToBytes(uuid) {
  const normalized = normalizeUuid(uuid);
  if (!normalized) throw new Error('UUID must be a valid UUIDv4');
  const hex = normalized.replaceAll('-', '');
  const out = new Uint8Array(16);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts) {
  const arrays = parts.filter(Boolean).map(part => part instanceof Uint8Array ? part : new Uint8Array(part));
  const total = arrays.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of arrays) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function equalBytes(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function safeDecode(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch { return String(value || ''); }
}

export function parseEndpoint(input, defaultPort = 443) {
  let text = String(input || '').trim();
  if (!text) return null;
  const hashAt = text.indexOf('#');
  const name = hashAt >= 0 ? safeDecode(text.slice(hashAt + 1).trim()) : '';
  if (hashAt >= 0) text = text.slice(0, hashAt).trim();
  if (!text) return null;

  let host = '';
  let port = defaultPort;
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close < 0) return null;
    host = text.slice(1, close);
    const rest = text.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      port = Number(rest.slice(1));
    }
  } else {
    const colonCount = (text.match(/:/g) || []).length;
    if (colonCount === 1) {
      const at = text.lastIndexOf(':');
      const maybePort = Number(text.slice(at + 1));
      if (Number.isInteger(maybePort)) {
        host = text.slice(0, at);
        port = maybePort;
      } else host = text;
    } else if (colonCount > 1) {
      host = text;
    } else host = text;
  }

  host = host.trim().replace(/^\[(.*)\]$/, '$1');
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, name: name || host };
}

export function parsePreferredList(input, defaultPort = 443) {
  const items = Array.isArray(input) ? input : String(input || '').split(/[\n,;]+/);
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const endpoint = typeof item === 'string' ? parseEndpoint(item, defaultPort) : item;
    if (!endpoint?.host || !endpoint?.port) continue;
    const key = `${endpoint.host.toLowerCase()}:${endpoint.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host: endpoint.host, port: endpoint.port, name: endpoint.name || endpoint.host });
  }
  return out;
}

export function parseProxyUrl(input) {
  let text = String(input || '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `socks5://${text}`;
  let url;
  try { url = new URL(text); } catch { return null; }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (!['socks5', 'http', 'https'].includes(scheme)) return null;
  const port = Number(url.port || (scheme === 'socks5' ? 1080 : scheme === 'https' ? 443 : 80));
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    scheme,
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port,
    username: safeDecode(url.username || ''),
    password: safeDecode(url.password || '')
  };
}

export function parseRoutes(input) {
  if (Array.isArray(input)) return input.map(normalizeRoute).filter(Boolean);
  return String(input || '')
    .split(/[\n;,]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const split = part.lastIndexOf('=');
      if (split < 1) return null;
      return normalizeRoute({ pattern: part.slice(0, split), policy: part.slice(split + 1) });
    })
    .filter(Boolean);
}

function normalizeRoute(route) {
  const pattern = String(route?.pattern || '').trim().toLowerCase();
  const policy = normalizePolicy(route?.policy);
  return pattern && policy ? { pattern, policy } : null;
}

export function normalizePolicy(value) {
  const text = String(value || '').trim().toLowerCase();
  const aliases = {
    auto: 'adaptive',
    adaptive: 'adaptive',
    smart: 'adaptive',
    proxy: 'proxy-first',
    'proxy-first': 'proxy-first',
    direct: 'direct',
    'direct-first': 'direct-first',
    only: 'proxy-only',
    'proxy-only': 'proxy-only',
    block: 'block'
  };
  return aliases[text] || '';
}

export function wildcardMatch(host, pattern) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  pattern = String(pattern || '').toLowerCase().replace(/\.$/, '');
  if (!host || !pattern) return false;
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  if (pattern.startsWith('*')) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

export function isIpv4(host) {
  const parts = String(host || '').split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function normalizeIpv6(host) {
  const text = String(host || '').trim().replace(/^\[(.*)\]$/, '$1');
  if (!text.includes(':') || text.includes('%')) return '';
  try {
    const hostname = new URL(`http://[${text}]/`).hostname;
    return hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  } catch {
    return '';
  }
}

export function isIpv6(host) {
  return Boolean(normalizeIpv6(host));
}

function isPrivateIpv4(host) {
  if (!isIpv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function mappedIpv4(normalizedIpv6) {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(normalizedIpv6);
  if (!match) return '';
  const hi = Number.parseInt(match[1], 16);
  const lo = Number.parseInt(match[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPrivateAddress(host) {
  const text = String(host || '').toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (isPrivateIpv4(text)) return true;

  const v6 = normalizeIpv6(text);
  if (v6) {
    if (v6 === '::' || v6 === '::1') return true;
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(v6)) return true;
    if (v6.startsWith('ff')) return true;
    const mapped = mappedIpv4(v6);
    if (mapped && isPrivateIpv4(mapped)) return true;
    return false;
  }

  return text === 'localhost' || text.endsWith('.localhost') || text.endsWith('.local');
}

export function resolvePolicy(host, config) {
  for (const route of config.routes || []) if (wildcardMatch(host, route.pattern)) return route.policy;
  return normalizePolicy(config.mode) || DEFAULTS.mode;
}

export function sanitizePath(value, fallback) {
  let path = String(value || fallback || '').trim();
  path = path.replace(/^\/+|\/+$/g, '');
  path = path.replace(/[^a-zA-Z0-9._~/-]/g, '');
  return path || String(fallback || '').replace(/^\/+|\/+$/g, '');
}

export function buildConfig(env = {}, stored = {}) {
  const uuid = normalizeUuid(stored.uuid ?? stored.UUID ?? env.UUID ?? env.uuid);
  const path = sanitizePath(stored.path ?? stored.PATH ?? env.PATH, uuid ? uuid.slice(0, 8) : '');
  const outboundRaw = stored.outbound ?? stored.OUTBOUND ?? env.OUTBOUND ?? env.PROXY ?? env.SOCKS5 ?? '';
  const mode = normalizePolicy(stored.mode ?? stored.MODE ?? env.MODE) || DEFAULTS.mode;
  return {
    uuid,
    uuidBytes: uuid ? uuidToBytes(uuid) : null,
    trojanPassword: String(stored.trojanPassword ?? stored.TROJAN_PASSWORD ?? env.TROJAN_PASSWORD ?? '').trim(),
    admin: String(stored.admin ?? stored.ADMIN ?? env.ADMIN ?? '').trim(),
    path,
    outbound: parseProxyUrl(outboundRaw),
    outboundRaw: String(outboundRaw || '').trim(),
    mode,
    proxyIp: parsePreferredList(stored.proxyIp ?? stored.PROXYIP ?? env.PROXYIP ?? ''),
    preferred: parsePreferredList(stored.preferred ?? stored.PREFERRED ?? env.PREFERRED ?? ''),
    routes: parseRoutes(stored.routes ?? stored.ROUTES ?? env.ROUTES ?? ''),
    dialRace: intValue(stored.dialRace ?? env.DIAL_RACE, DEFAULTS.dialRace, 1, 4),
    hedgeDelayMs: intValue(stored.hedgeDelayMs ?? env.HEDGE_DELAY, DEFAULTS.hedgeDelayMs, 100, 5000),
    firstByteTimeoutMs: intValue(stored.firstByteTimeoutMs ?? env.FIRST_BYTE_TIMEOUT, DEFAULTS.firstByteTimeoutMs, 1000, 15000),
    edgeFirstByteTimeoutMs: intValue(stored.edgeFirstByteTimeoutMs ?? env.EDGE_FIRST_BYTE_TIMEOUT, DEFAULTS.edgeFirstByteTimeoutMs, 750, 10000),
    edgeRace: intValue(stored.edgeRace ?? env.EDGE_RACE, DEFAULTS.edgeRace, 1, 4),
    adaptiveEdge: boolValue(stored.adaptiveEdge ?? env.ADAPTIVE_EDGE, DEFAULTS.adaptiveEdge),
    maxEarlyDataBytes: intValue(stored.maxEarlyDataBytes ?? env.MAX_EARLY_DATA, DEFAULTS.maxEarlyDataBytes, 0, 16384),
    uploadCoalesceBytes: intValue(stored.uploadCoalesceBytes ?? env.UPLOAD_COALESCE, DEFAULTS.uploadCoalesceBytes, 1024, 65536),
    uploadQueueBytes: intValue(stored.uploadQueueBytes ?? env.UPLOAD_QUEUE, DEFAULTS.uploadQueueBytes, 64 * 1024, 16 * 1024 * 1024),
    downloadGrainBytes: intValue(stored.downloadGrainBytes ?? env.DOWNLOAD_GRAIN, DEFAULTS.downloadGrainBytes, 4096, 65536),
    enableWs: boolValue(stored.enableWs ?? env.ENABLE_WS, DEFAULTS.enableWs),
    enableXhttp: boolValue(stored.enableXhttp ?? env.ENABLE_XHTTP, DEFAULTS.enableXhttp),
    blockPrivate: boolValue(stored.blockPrivate ?? env.BLOCK_PRIVATE, DEFAULTS.blockPrivate),
    disableIpv6: boolValue(stored.disableIpv6 ?? env.DISABLE_IPV6, DEFAULTS.disableIpv6),
    allowPathOverride: boolValue(stored.allowPathOverride ?? env.ALLOW_PATH_OVERRIDE, DEFAULTS.allowPathOverride),
    rootMode: String(stored.rootMode ?? env.ROOT_MODE ?? DEFAULTS.rootMode).trim().toLowerCase(),
    subscriptionName: String(stored.subscriptionName ?? env.SUB_NAME ?? 'Unisol').trim() || 'Unisol'
  };
}

export function applyConnectionOverrides(config, url) {
  if (!config.allowPathOverride) return config;
  const params = url.searchParams;
  const clone = { ...config };
  if (params.has('proxy')) {
    clone.outboundRaw = params.get('proxy') || '';
    clone.outbound = parseProxyUrl(clone.outboundRaw);
  }
  if (params.has('mode')) clone.mode = normalizePolicy(params.get('mode')) || clone.mode;
  if (params.has('proxyip')) clone.proxyIp = parsePreferredList(params.get('proxyip'));
  if (params.has('no6')) clone.disableIpv6 = boolValue(params.get('no6'), clone.disableIpv6);
  return clone;
}

export function routeKind(pathname, config) {
  const path = pathname.replace(/^\/+|\/+$/g, '');
  if (path === 'health') return { kind: 'health' };
  if (path === 'admin') return { kind: 'admin' };
  if (path === 'api/config') return { kind: 'config-api' };

  const prefix = config.path;
  if (!prefix) return { kind: 'invalid' };
  if (path === `${prefix}/ws` || path === prefix) return { kind: 'ws' };
  if (path === `${prefix}/xhttp`) return { kind: 'xhttp' };
  if (path === `sub/${prefix}` || path === `${prefix}/sub`) return { kind: 'sub' };
  return { kind: 'other' };
}

export function safeConfigView(config) {
  return {
    version: VERSION,
    uuid: config.uuid,
    path: config.path,
    trojanEnabled: Boolean(config.trojanPassword),
    outbound: config.outboundRaw ? redactProxy(config.outboundRaw) : '',
    mode: config.mode,
    proxyIp: config.proxyIp,
    preferred: config.preferred,
    routes: config.routes,
    dialRace: config.dialRace,
    hedgeDelayMs: config.hedgeDelayMs,
    firstByteTimeoutMs: config.firstByteTimeoutMs,
    edgeFirstByteTimeoutMs: config.edgeFirstByteTimeoutMs,
    edgeRace: config.edgeRace,
    adaptiveEdge: config.adaptiveEdge,
    enableWs: config.enableWs,
    enableXhttp: config.enableXhttp,
    blockPrivate: config.blockPrivate,
    disableIpv6: config.disableIpv6,
    allowPathOverride: config.allowPathOverride,
    rootMode: config.rootMode,
    subscriptionName: config.subscriptionName
  };
}

export function redactProxy(value) {
  try {
    let text = String(value || '');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `socks5://${text}`;
    const url = new URL(text);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}
