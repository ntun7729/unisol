import { isIpv4 } from './core.js';

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const CACHE_MS = 5 * 60 * 1000;

// Cloudflare CDN addresses are Anycast. This is intentionally ONE fixed edge
// address so adaptive mode never fans out across a pool. The address is from
// cfnew's current tested official-direct set and its /24 is commonly geolocated
// to Singapore, but Cloudflare Anycast still decides the actual PoP reached.
export const SINGLE_CF_EDGE_IP = '162.158.189.134';

export const CLOUDFLARE_IPV4_CIDRS = Object.freeze([
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22'
]);

const parsedCidrs = CLOUDFLARE_IPV4_CIDRS.map(parseCidr).filter(Boolean);
const dnsCache = new Map();

export function isCloudflareIpv4(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return parsedCidrs.some(range => (value & range.mask) === range.network);
}

export function sniffApplicationHost(initialData, requestedHost = '') {
  const bytes = initialData instanceof Uint8Array ? initialData : new Uint8Array(initialData || 0);
  const tls = extractTlsServerName(bytes);
  if (tls) return { kind: 'tls', host: tls };
  const http = extractHttpHost(bytes);
  if (http) return { kind: 'http', host: http };
  return { kind: 'unknown', host: normalizeHost(requestedHost) };
}

export function extractTlsServerName(bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5) return '';
    if (bytes[0] !== 0x16) return '';
    const recordLength = (bytes[3] << 8) | bytes[4];
    if (recordLength < 4 || bytes.byteLength < Math.min(5 + recordLength, 9)) return '';
    let p = 5;
    if (bytes[p++] !== 0x01) return '';
    const helloLength = (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2];
    p += 3;
    const end = Math.min(bytes.byteLength, p + helloLength);
    if (p + 34 > end) return '';
    p += 2 + 32;
    if (p >= end) return '';
    const sessionLength = bytes[p++];
    p += sessionLength;
    if (p + 2 > end) return '';
    const cipherLength = (bytes[p] << 8) | bytes[p + 1];
    p += 2 + cipherLength;
    if (p >= end) return '';
    const compressionLength = bytes[p++];
    p += compressionLength;
    if (p + 2 > end) return '';
    const extensionsLength = (bytes[p] << 8) | bytes[p + 1];
    p += 2;
    const extensionsEnd = Math.min(end, p + extensionsLength);
    while (p + 4 <= extensionsEnd) {
      const type = (bytes[p] << 8) | bytes[p + 1];
      const length = (bytes[p + 2] << 8) | bytes[p + 3];
      p += 4;
      if (p + length > extensionsEnd) return '';
      if (type === 0 && length >= 5) {
        let q = p;
        const listLength = (bytes[q] << 8) | bytes[q + 1];
        q += 2;
        const listEnd = Math.min(p + length, q + listLength);
        while (q + 3 <= listEnd) {
          const nameType = bytes[q++];
          const nameLength = (bytes[q] << 8) | bytes[q + 1];
          q += 2;
          if (q + nameLength > listEnd) return '';
          if (nameType === 0) {
            const host = normalizeHost(new TextDecoder().decode(bytes.subarray(q, q + nameLength)));
            return isHostname(host) ? host : '';
          }
          q += nameLength;
        }
      }
      p += length;
    }
  } catch {}
  return '';
}

export function extractHttpHost(bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength) return '';
    const sample = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 8192)));
    if (!/^(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH|CONNECT|TRACE)\s+\S+\s+HTTP\/1\.[01]\r?\n/i.test(sample)) return '';
    const match = /\r?\nHost:\s*([^\r\n]+)/i.exec(sample);
    if (!match) return '';
    const host = stripPort(match[1].trim());
    return isHostname(host) ? host : '';
  } catch {
    return '';
  }
}

export function isEdgeEligiblePort(port) {
  return new Set([80, 443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8080, 8443, 8880]).has(Number(port));
}

export async function discoverCloudflareEdge({ host, port, initialData, fetcher = fetch }) {
  if (!isEdgeEligiblePort(port)) return { eligible: false, reason: 'unsupported-port', candidates: [] };

  const app = sniffApplicationHost(initialData, host);
  const routeHost = app.host || normalizeHost(host);
  if (!routeHost) return { eligible: false, reason: 'missing-host', candidates: [] };

  let targetAddresses = [];
  if (isIpv4(routeHost)) targetAddresses = [routeHost];
  else if (isHostname(routeHost)) targetAddresses = await resolveA(routeHost, fetcher);
  else return { eligible: false, reason: 'unsupported-host', candidates: [] };

  const targetCloudflare = targetAddresses.filter(isCloudflareIpv4);
  if (!targetCloudflare.length) {
    return { eligible: false, reason: 'not-cloudflare', application: app.kind, routeHost, resolved: [], candidates: [] };
  }

  return {
    eligible: true,
    reason: 'cloudflare',
    application: app.kind,
    routeHost,
    resolved: targetCloudflare,
    candidates: [{ host: SINGLE_CF_EDGE_IP, source: 'sg-preferred-anycast' }]
  };
}

// Retained for compatibility with older tests/imports. Adaptive v0.2.1 no longer
// maintains an edge pool or health ranking because only one fixed candidate exists.
export function noteEdgeSuccess() {}
export function noteEdgeFailure() {}

export function clearAdaptiveState() {
  dnsCache.clear();
}

async function resolveA(host, fetcher) {
  const key = normalizeHost(host);
  if (!key) return [];
  const now = Date.now();
  const cached = dnsCache.get(key);
  if (cached && cached.expires > now) return cached.addresses;
  try {
    const response = await fetcher(`${DOH_URL}?name=${encodeURIComponent(key)}&type=A`, {
      headers: { Accept: 'application/dns-json' }
    });
    if (!response?.ok) throw new Error(`DoH ${response?.status || 0}`);
    const data = await response.json();
    const answers = Array.isArray(data?.Answer) ? data.Answer : [];
    const addresses = [];
    let ttl = 300;
    for (const answer of answers) {
      if (Number(answer?.type) !== 1 || !isIpv4(answer?.data)) continue;
      addresses.push(String(answer.data));
      if (Number.isFinite(Number(answer.TTL))) ttl = Math.min(ttl, Math.max(30, Number(answer.TTL)));
    }
    const value = [...new Set(addresses)];
    dnsCache.set(key, { addresses: value, expires: now + Math.min(CACHE_MS, ttl * 1000) });
    return value;
  } catch {
    dnsCache.set(key, { addresses: [], expires: now + 15_000 });
    return [];
  }
}

function parseCidr(cidr) {
  const [ip, prefixText] = String(cidr).split('/');
  const networkValue = ipv4ToInt(ip);
  const prefix = Number(prefixText);
  if (networkValue === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: networkValue & mask, mask };
}

function ipv4ToInt(ip) {
  if (!isIpv4(ip)) return null;
  return String(ip).split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

function stripPort(authority) {
  const text = normalizeHost(authority);
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    return end >= 0 ? text.slice(1, end) : text;
  }
  const colonCount = (text.match(/:/g) || []).length;
  if (colonCount === 1) return text.slice(0, text.lastIndexOf(':')) || text;
  return text;
}

function isHostname(host) {
  const text = normalizeHost(host);
  if (!text || isIpv4(text) || text.includes(':') || text.length > 253) return false;
  return text.split('.').every(label => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}
