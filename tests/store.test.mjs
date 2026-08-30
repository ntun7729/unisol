import test from 'node:test';
import assert from 'node:assert/strict';
import { clearConfigCache, loadStoredConfig, sanitizeStoredConfig, saveStoredConfig } from '../src/store.js';

function fakeKv(initial = null) {
  let value = initial;
  return {
    async get(key) {
      assert.equal(key, 'unisol:config');
      return value;
    },
    async put(key, next) {
      assert.equal(key, 'unisol:config');
      value = next;
    },
    read() { return value; }
  };
}

test('sanitizeStoredConfig keeps only supported keys and never persists admin', () => {
  assert.deepEqual(sanitizeStoredConfig({
    uuid: 'u',
    mode: 'direct',
    admin: 'must-not-persist',
    random: 'drop-me',
    uploadQueueBytes: 123
  }), {
    uuid: 'u',
    mode: 'direct',
    uploadQueueBytes: 123
  });
  assert.deepEqual(sanitizeStoredConfig([]), {});
  assert.deepEqual(sanitizeStoredConfig(null), {});
});

test('saveStoredConfig writes sanitized JSON and refreshes the local cache', async () => {
  clearConfigCache();
  const KV = fakeKv();
  const saved = await saveStoredConfig({ KV }, { uuid: 'u', mode: 'direct', admin: 'drop' });
  assert.deepEqual(saved, { uuid: 'u', mode: 'direct' });
  assert.deepEqual(JSON.parse(KV.read()), { uuid: 'u', mode: 'direct' });
  assert.deepEqual(await loadStoredConfig({ KV }), { uuid: 'u', mode: 'direct' });
});

test('loadStoredConfig rejects malformed JSON and non-object persisted values', async () => {
  clearConfigCache();
  assert.deepEqual(await loadStoredConfig({ KV: fakeKv('{bad json') }), {});
  clearConfigCache();
  assert.deepEqual(await loadStoredConfig({ KV: fakeKv('["not","config"]') }), {});
});
