import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyConnectionOverrides,
  buildConfig,
  isPrivateAddress,
  parseEndpoint,
  parseProxyUrl,
  parseRoutes,
  resolvePolicy,
  wildcardMatch
} from '../src/core.js';

const UUID = '90cd4a77-141a-43c9-991b-08263cfe9c10';

test('parseEndpoint handles domains, IPv4, bracketed IPv6, and names', () => {
  assert.deepEqual(parseEndpoint('edge.example:8443#SG'), { host: 'edge.example', port: 8443, name: 'SG' });
  assert.deepEqual(parseEndpoint('1.2.3.4:443'), { host: '1.2.3.4', port: 443, name: '1.2.3.4' });
  assert.deepEqual(parseEndpoint('[2606:4700:4700::1111]:2053#v6'), { host: '2606:4700:4700::1111', port: 2053, name: 'v6' });
  assert.deepEqual(parseEndpoint('2606:4700:4700::1111'), { host: '2606:4700:4700::1111', port: 443, name: '2606:4700:4700::1111' });
});

test('parseProxyUrl supports socks5/http/https and auth', () => {
  assert.deepEqual(parseProxyUrl('user:pass@proxy.example:1080'), {
    scheme: 'socks5', host: 'proxy.example', port: 1080, username: 'user', password: 'pass'
  });
  assert.equal(parseProxyUrl('http://proxy.example').port, 80);
  assert.equal(parseProxyUrl('https://proxy.example').port, 443);
  assert.equal(parseProxyUrl('ftp://proxy.example'), null);
});

test('route patterns and policies are deterministic', () => {
  const routes = parseRoutes('*.example.com=proxy-only; api.test=direct; *.blocked=block');
  const config = { mode: 'proxy-first', routes };
  assert.equal(wildcardMatch('www.example.com', '*.example.com'), true);
  assert.equal(wildcardMatch('example.com', '*.example.com'), false);
  assert.equal(resolvePolicy('www.example.com', config), 'proxy-only');
  assert.equal(resolvePolicy('api.test', config), 'direct');
  assert.equal(resolvePolicy('x.blocked', config), 'block');
  assert.equal(resolvePolicy('other.test', config), 'proxy-first');
});

test('private and local destinations are identified', () => {
  for (const host of ['127.0.0.1', '10.2.3.4', '172.16.5.1', '192.168.1.1', '169.254.1.1', 'localhost', 'x.local', '::1', 'fd00::1']) {
    assert.equal(isPrivateAddress(host), true, host);
  }
  for (const host of ['1.1.1.1', '8.8.8.8', 'example.com', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(host), false, host);
});

test('buildConfig merges environment and stored values with validation', () => {
  const config = buildConfig({
    UUID,
    OUTBOUND: 'https://user:pw@proxy.example:443',
    MODE: 'only',
    PROXYIP: '[2606:4700::1]:443#v6, fallback.example:8443',
    ROUTES: '*.video.example=direct-first',
    DISABLE_IPV6: 'true'
  }, { subscriptionName: 'Stored Name' });
  assert.equal(config.uuid, UUID);
  assert.equal(config.mode, 'proxy-only');
  assert.equal(config.outbound.scheme, 'https');
  assert.equal(config.proxyIp.length, 2);
  assert.equal(config.routes[0].policy, 'direct-first');
  assert.equal(config.disableIpv6, true);
  assert.equal(config.subscriptionName, 'Stored Name');
});

test('connection overrides are gated and parsed', () => {
  const base = buildConfig({ UUID, ALLOW_PATH_OVERRIDE: 'true', MODE: 'direct' }, {});
  const changed = applyConnectionOverrides(base, new URL('https://worker.example/x?proxy=http%3A%2F%2Fp.example%3A8080&mode=only&proxyip=f.example%3A443&no6=1'));
  assert.equal(changed.outbound.scheme, 'http');
  assert.equal(changed.mode, 'proxy-only');
  assert.equal(changed.proxyIp[0].host, 'f.example');
  assert.equal(changed.disableIpv6, true);

  const locked = buildConfig({ UUID, ALLOW_PATH_OVERRIDE: 'false', MODE: 'direct' }, {});
  assert.equal(applyConnectionOverrides(locked, new URL('https://worker.example/x?mode=only')).mode, 'direct');
});
