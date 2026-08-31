import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SINGLE_CF_EDGE_IP,
  clearAdaptiveState,
  discoverCloudflareEdge,
  extractHttpHost,
  extractTlsServerName,
  isCloudflareIpv4,
  sniffApplicationHost
} from '../src/adaptive.js';

const encoder = new TextEncoder();

function tlsClientHello(host) {
  const name = encoder.encode(host);
  const serverName = new Uint8Array(3 + name.length);
  serverName[0] = 0;
  serverName[1] = name.length >> 8;
  serverName[2] = name.length & 255;
  serverName.set(name, 3);

  const list = new Uint8Array(2 + serverName.length);
  list[0] = serverName.length >> 8;
  list[1] = serverName.length & 255;
  list.set(serverName, 2);

  const sni = new Uint8Array(4 + list.length);
  sni[0] = 0;
  sni[1] = 0;
  sni[2] = list.length >> 8;
  sni[3] = list.length & 255;
  sni.set(list, 4);

  const extensions = new Uint8Array(2 + sni.length);
  extensions[0] = sni.length >> 8;
  extensions[1] = sni.length & 255;
  extensions.set(sni, 2);

  const body = new Uint8Array(2 + 32 + 1 + 2 + 2 + 1 + 1 + extensions.length);
  let p = 0;
  body.set([3, 3], p); p += 2;
  p += 32;
  body[p++] = 0;
  body.set([0, 2, 0x13, 0x01], p); p += 4;
  body.set([1, 0], p); p += 2;
  body.set(extensions, p);

  const handshake = new Uint8Array(4 + body.length);
  handshake[0] = 1;
  handshake[1] = body.length >> 16;
  handshake[2] = body.length >> 8;
  handshake[3] = body.length;
  handshake.set(body, 4);

  const record = new Uint8Array(5 + handshake.length);
  record.set([0x16, 0x03, 0x01, handshake.length >> 8, handshake.length & 255], 0);
  record.set(handshake, 5);
  return record;
}

function dnsFetcher(map, seen = null) {
  return async url => {
    const parsed = new URL(url);
    const name = parsed.searchParams.get('name');
    if (seen) seen.push(name);
    const addresses = map[name] || [];
    return new Response(JSON.stringify({
      Status: 0,
      Answer: addresses.map(address => ({ name: `${name}.`, type: 1, TTL: 60, data: address }))
    }), { status: 200, headers: { 'Content-Type': 'application/dns-json' } });
  };
}

test('Cloudflare IPv4 ranges are recognized without matching unrelated public IPs', () => {
  assert.equal(isCloudflareIpv4('104.18.10.20'), true);
  assert.equal(isCloudflareIpv4('172.67.1.2'), true);
  assert.equal(isCloudflareIpv4('162.159.36.1'), true);
  assert.equal(isCloudflareIpv4('8.8.8.8'), false);
});

test('application sniffing extracts TLS SNI and plaintext HTTP Host', () => {
  const tls = tlsClientHello('Example.COM');
  assert.equal(extractTlsServerName(tls), 'example.com');
  assert.deepEqual(sniffApplicationHost(tls, 'ignored.test'), { kind: 'tls', host: 'example.com' });

  const http = encoder.encode('GET / HTTP/1.1\r\nHost: cf.example:8080\r\nConnection: close\r\n\r\n');
  assert.equal(extractHttpHost(http), 'cf.example');
  assert.deepEqual(sniffApplicationHost(http, 'ignored.test'), { kind: 'http', host: 'cf.example' });
});

test('edge discovery returns exactly one fixed Cloudflare candidate', async () => {
  clearAdaptiveState();
  const seen = [];
  const result = await discoverCloudflareEdge({
    host: 'site.example',
    port: 443,
    initialData: tlsClientHello('site.example'),
    fetcher: dnsFetcher({
      'site.example': ['104.18.22.10', '172.67.10.20']
    }, seen),
    edgeRace: 4
  });
  assert.equal(result.eligible, true);
  assert.equal(result.application, 'tls');
  assert.equal(result.routeHost, 'site.example');
  assert.deepEqual(result.resolved, ['104.18.22.10', '172.67.10.20']);
  assert.deepEqual(result.candidates, [{ host: SINGLE_CF_EDGE_IP, source: 'sg-preferred-anycast' }]);
  assert.deepEqual(seen, ['site.example']);
});

test('edge discovery skips non-Cloudflare destinations', async () => {
  clearAdaptiveState();
  const result = await discoverCloudflareEdge({
    host: 'example.net',
    port: 443,
    initialData: tlsClientHello('example.net'),
    fetcher: dnsFetcher({ 'example.net': ['93.184.216.34'] })
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not-cloudflare');
  assert.deepEqual(result.candidates, []);
});
