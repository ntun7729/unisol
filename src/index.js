import { connect } from 'cloudflare:sockets';
import { applyConnectionOverrides, buildConfig, routeKind, VERSION } from './core.js';
import { handleWebSocket, handleXhttp } from './session.js';
import { renderSubscription } from './subscription.js';
import { loadStoredConfig, saveStoredConfig } from './store.js';
import { adminPage, cafePage, configApiResponse, isAdminAuthorized } from './ui.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.protocol === 'http:') {
        url.protocol = 'https:';
        return Response.redirect(url.toString(), 301);
      }

      // Root camouflage is intentionally cheap and does not read KV.
      if (url.pathname === '/' && request.method === 'GET') {
        const envConfig = buildConfig(env, {});
        if (envConfig.rootMode === '404') return new Response('Not Found', { status: 404 });
        return html(cafePage());
      }

      const stored = await loadStoredConfig(env);
      const config = buildConfig(env, stored);
      const route = routeKind(url.pathname, config);

      if (route.kind === 'health' && request.method === 'GET') {
        return json({
          ok: true,
          version: VERSION,
          configured: Boolean(config.uuid),
          kv: Boolean(env?.KV && typeof env.KV.get === 'function'),
          ws: config.enableWs,
          xhttp: config.enableXhttp
        });
      }

      if (route.kind === 'admin' && request.method === 'GET') {
        if (!config.admin) return new Response('Not Found', { status: 404 });
        return html(adminPage(), { 'Cache-Control': 'no-store' });
      }

      if (route.kind === 'config-api') return handleConfigApi(request, env, config);

      if (!config.uuid) {
        if (route.kind === 'sub' || route.kind === 'ws' || route.kind === 'xhttp') {
          return new Response('Worker is not configured: set UUID.', { status: 503 });
        }
        return new Response('Not Found', { status: 404 });
      }

      if (route.kind === 'sub' && request.method === 'GET') {
        const format = url.searchParams.get('format') || formatFromUserAgent(request.headers.get('User-Agent'));
        const rendered = renderSubscription(config, url, format);
        return new Response(rendered.body, {
          status: 200,
          headers: {
            'Content-Type': rendered.contentType,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Subscription-Userinfo': 'upload=0; download=0; total=0; expire=0'
          }
        });
      }

      if (route.kind === 'ws') {
        const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
        if (!config.enableWs || upgrade !== 'websocket') return new Response('Not Found', { status: 404 });
        const connectionConfig = applyConnectionOverrides(config, url);
        return handleWebSocket(request, connectionConfig, connect);
      }

      if (route.kind === 'xhttp') {
        if (!config.enableXhttp || request.method !== 'POST') return new Response('Not Found', { status: 404 });
        const connectionConfig = applyConnectionOverrides(config, url);
        return handleXhttp(request, connectionConfig, connect, ctx);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('[unisol]', error?.stack || error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};

async function handleConfigApi(request, env, config) {
  if (!isAdminAuthorized(request, config.admin)) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer realm="Unisol"', 'Cache-Control': 'no-store' }
    });
  }

  const kvEnabled = Boolean(env?.KV && typeof env.KV.get === 'function' && typeof env.KV.put === 'function');
  if (request.method === 'GET') return json(configApiResponse(config, kvEnabled));
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  if (!kvEnabled) return json({ error: 'KV binding is not configured' }, 503);

  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 64 * 1024) return json({ error: 'configuration payload too large' }, 413);

  let payload;
  try {
    const text = await request.text();
    if (text.length > 64 * 1024) return json({ error: 'configuration payload too large' }, 413);
    payload = JSON.parse(text || '{}');
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  try {
    const saved = await saveStoredConfig(env, payload);
    const next = buildConfig(env, saved);
    if (!next.uuid) return json({ error: 'UUID must be a valid UUIDv4' }, 400);
    return json(configApiResponse(next, true));
  } catch (error) {
    return json({ error: error?.message || 'failed to save configuration' }, 400);
  }
}

function formatFromUserAgent(userAgent = '') {
  const ua = String(userAgent).toLowerCase();
  if (ua.includes('clash') || ua.includes('mihomo')) return 'clash';
  if (ua.includes('sing-box') || ua.includes('singbox')) return 'singbox';
  return 'base64';
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), { status, headers: JSON_HEADERS });
}

function html(value, extraHeaders = {}) {
  return new Response(value, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders }
  });
}
