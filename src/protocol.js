import { concatBytes, equalBytes, isIpv4, normalizeIpv6 } from './core.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function needMore() { return { status: 'need-more' }; }
function failure(error) { return { status: 'error', error }; }

export function parseVless(buffer, expectedUuidBytes) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 18) return needMore();
  const version = bytes[0];
  if (!expectedUuidBytes || !equalBytes(bytes.subarray(1, 17), expectedUuidBytes)) return failure('invalid VLESS user');
  const optionLength = bytes[17];
  let offset = 18 + optionLength;
  if (bytes.byteLength < offset + 4) return needMore();

  const command = bytes[offset++];
  if (command !== 1 && command !== 2) return failure(`unsupported VLESS command ${command}`);
  const port = (bytes[offset] << 8) | bytes[offset + 1];
  offset += 2;
  const addressType = bytes[offset++];
  const address = parseAddress(bytes, offset, addressType, 'vless');
  if (address.status !== 'ok') return address;
  offset = address.offset;

  return {
    status: 'ok',
    protocol: 'vless',
    version,
    command,
    udp: command === 2,
    host: address.host,
    port,
    payload: bytes.subarray(offset),
    consumed: offset,
    responseHeader: new Uint8Array([version, 0])
  };
}

export function parseTrojan(buffer, password) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (!password) return failure('Trojan disabled');
  if (bytes.byteLength < 60) return needMore();
  const expected = sha224(password);
  const supplied = decoder.decode(bytes.subarray(0, 56)).toLowerCase();
  if (supplied !== expected || bytes[56] !== 13 || bytes[57] !== 10) return failure('invalid Trojan user');
  let offset = 58;
  const command = bytes[offset++];
  if (command !== 1 && command !== 3) return failure(`unsupported Trojan command ${command}`);
  const addressType = bytes[offset++];
  const address = parseAddress(bytes, offset, addressType, 'socks');
  if (address.status !== 'ok') return address;
  offset = address.offset;
  if (bytes.byteLength < offset + 4) return needMore();
  const port = (bytes[offset] << 8) | bytes[offset + 1];
  offset += 2;
  if (bytes[offset] !== 13 || bytes[offset + 1] !== 10) return failure('invalid Trojan request terminator');
  offset += 2;
  return {
    status: 'ok',
    protocol: 'trojan',
    command,
    udp: command === 3,
    host: address.host,
    port,
    payload: bytes.subarray(offset),
    consumed: offset,
    responseHeader: null
  };
}

export function parseInbound(buffer, config) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 18) return needMore();

  const vless = parseVless(bytes, config.uuidBytes);
  if (vless.status === 'ok') return vless;
  if (vless.status === 'need-more') return vless;

  if (config.trojanPassword) {
    const trojan = parseTrojan(bytes, config.trojanPassword);
    if (trojan.status !== 'error' || bytes.byteLength >= 60) return trojan;
  }
  return vless;
}

function parseAddress(bytes, offset, type, family) {
  if (family === 'vless') {
    if (type === 1) {
      if (bytes.byteLength < offset + 4) return needMore();
      return { status: 'ok', host: Array.from(bytes.subarray(offset, offset + 4)).join('.'), offset: offset + 4 };
    }
    if (type === 2) {
      if (bytes.byteLength < offset + 1) return needMore();
      const len = bytes[offset++];
      if (!len || bytes.byteLength < offset + len) return needMore();
      return { status: 'ok', host: decoder.decode(bytes.subarray(offset, offset + len)), offset: offset + len };
    }
    if (type === 3) {
      if (bytes.byteLength < offset + 16) return needMore();
      return { status: 'ok', host: ipv6FromBytes(bytes.subarray(offset, offset + 16)), offset: offset + 16 };
    }
  } else {
    if (type === 1) {
      if (bytes.byteLength < offset + 4) return needMore();
      return { status: 'ok', host: Array.from(bytes.subarray(offset, offset + 4)).join('.'), offset: offset + 4 };
    }
    if (type === 3) {
      if (bytes.byteLength < offset + 1) return needMore();
      const len = bytes[offset++];
      if (!len || bytes.byteLength < offset + len) return needMore();
      return { status: 'ok', host: decoder.decode(bytes.subarray(offset, offset + len)), offset: offset + len };
    }
    if (type === 4) {
      if (bytes.byteLength < offset + 16) return needMore();
      return { status: 'ok', host: ipv6FromBytes(bytes.subarray(offset, offset + 16)), offset: offset + 16 };
    }
  }
  return failure(`unsupported address type ${type}`);
}

export function ipv6FromBytes(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return groups.join(':');
}

export function encodeSocksAddress(host, port) {
  let address;
  if (isIpv4(host)) {
    address = new Uint8Array([1, ...host.split('.').map(Number)]);
  } else {
    const normalizedV6 = normalizeIpv6(host);
    if (normalizedV6) {
      const groups = expandIpv6(normalizedV6);
      address = new Uint8Array(1 + 16);
      address[0] = 4;
      groups.forEach((group, index) => {
        address[1 + index * 2] = group >> 8;
        address[2 + index * 2] = group & 255;
      });
    } else {
      if (host.includes(':')) throw new Error('invalid IPv6 address');
      const name = encoder.encode(host);
      if (!name.byteLength || name.byteLength > 255) throw new Error('hostname length invalid');
      address = new Uint8Array([3, name.byteLength, ...name]);
    }
  }
  return concatBytes(address, new Uint8Array([port >> 8, port & 255]));
}

function expandIpv6(host) {
  const [leftRaw, rightRaw = ''] = host.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  if (!host.includes('::') && left.length !== 8) throw new Error('invalid IPv6 address');
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (host.includes('::') && missing < 1)) throw new Error('invalid IPv6 address');
  const all = [...left, ...Array(missing).fill('0'), ...right];
  if (all.length !== 8) throw new Error('invalid IPv6 address');
  return all.map(part => {
    const n = Number.parseInt(part || '0', 16);
    if (!/^[0-9a-f]{1,4}$/i.test(part || '0') || !Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error('invalid IPv6 address');
    return n;
  });
}

export function decodeEarlyData(header, maxBytes = 8192) {
  const text = String(header || '').trim();
  if (!text || text.includes(',') || !/^[A-Za-z0-9_-]+={0,2}$/.test(text)) return new Uint8Array(0);
  try {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
    const binary = atob(normalized);
    if (binary.length > maxBytes) return new Uint8Array(0);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

// Compact SHA-224 implementation for Trojan authentication.
export function sha224(message) {
  const bytes = encoder.encode(String(message));
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);

  let h0 = 0xc1059ed8, h1 = 0x367cd507, h2 = 0x3070dd17, h3 = 0xf70e5939;
  let h4 = 0xffc00b31, h5 = 0x68581511, h6 = 0x64f98fa7, h7 = 0xbefa4fa4;
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81b70,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];

  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
    h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
  }
  return [h0,h1,h2,h3,h4,h5,h6].map(n => n.toString(16).padStart(8,'0')).join('');
}
