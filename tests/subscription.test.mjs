import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/core.js';
import { buildNodes, nodeToUri, renderSubscription } from '../src/subscription.js';

const UUID = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const URL = new globalThis.URL('https://worker.example/sub/90cd4a77');

test('buildNodes creates WS and XHTTP VLESS nodes plus optional Trojan', () => {
  const config = buildConfig({ UUID, TROJAN_PASSWORD: 'secret', ENABLE_WS: 'true', ENABLE_XHTTP: 'true' }, {});
  const nodes = buildNodes(config, URL);
  assert.equal(nodes.length, 4);
  assert.equal(nodes.filter(x => x.transport === 'ws').length, 2);
  assert.equal(nodes.filter(x => x.transport === 'xhttp').length, 2);
  assert.equal(nodes.filter(x => x.protocol === 'trojan').length, 2);
});

test('raw XHTTP URI carries stream-one mode', () => {
  const config = buildConfig({ UUID, ENABLE_WS: 'false', ENABLE_XHTTP: 'true' }, {});
  const node = buildNodes(config, URL)[0];
  const uri = nodeToUri(node);
  assert.match(uri, /^vless:\/\//);
  assert.match(uri, /type=xhttp/);
  assert.match(uri, /mode=stream-one/);
});

test('Clash and Sing-box output only transports they can consume here', () => {
  const config = buildConfig({ UUID, ENABLE_WS: 'true', ENABLE_XHTTP: 'true' }, {});
  const clash = renderSubscription(config, URL, 'clash').body;
  const singbox = renderSubscription(config, URL, 'singbox').body;
  assert.match(clash, /network: ws/);
  assert.doesNotMatch(clash, /xhttp/);
  assert.match(singbox, /"type": "ws"/);
  assert.doesNotMatch(singbox, /xhttp/);
});

test('disableIpv6 removes IPv6 preferred endpoints', () => {
  const config = buildConfig({ UUID, DISABLE_IPV6: 'true', PREFERRED: '[2606:4700::1]:443#v6, edge.example:443#v4' }, {});
  const nodes = buildNodes(config, URL);
  assert.equal(nodes.some(x => x.server.includes(':')), false);
  assert.equal(nodes.every(x => x.server === 'edge.example'), true);
});

test('base64 subscription decodes to node URIs', () => {
  const config = buildConfig({ UUID, ENABLE_WS: 'true', ENABLE_XHTTP: 'false' }, {});
  const rendered = renderSubscription(config, URL, 'base64');
  const decoded = Buffer.from(rendered.body, 'base64').toString('utf8');
  assert.match(decoded, /^vless:\/\//);
  assert.match(decoded, /worker\.example/);
});
