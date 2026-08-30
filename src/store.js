const KEY = 'unisol:config';
const CACHE_MS = 30_000;
let cache = { expires: 0, value: {} };

export async function loadStoredConfig(env) {
  if (!env?.KV || typeof env.KV.get !== 'function') return {};
  const now = Date.now();
  if (cache.expires > now) return cache.value;
  try {
    const raw = await env.KV.get(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? sanitizeStoredConfig(parsed) : {};
    cache = { expires: now + CACHE_MS, value };
    return value;
  } catch {
    cache = { expires: now + 5_000, value: {} };
    return {};
  }
}

export async function saveStoredConfig(env, input) {
  if (!env?.KV || typeof env.KV.put !== 'function') throw new Error('KV binding is not configured');
  const value = sanitizeStoredConfig(input);
  await env.KV.put(KEY, JSON.stringify(value));
  cache = { expires: Date.now() + CACHE_MS, value };
  return value;
}

export function sanitizeStoredConfig(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const allowed = [
    'uuid','path','trojanPassword','outbound','mode','proxyIp','preferred','routes',
    'dialRace','enableWs','enableXhttp','blockPrivate','disableIpv6','allowPathOverride',
    'rootMode','subscriptionName','maxEarlyDataBytes','uploadCoalesceBytes','uploadQueueBytes','downloadGrainBytes'
  ];
  const out = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  return out;
}

export function clearConfigCache() {
  cache = { expires: 0, value: {} };
}
