import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pushIfNeeded, STATE_KEY } from '../src/trmnl.js';

const NOW = Date.parse('2026-11-02T18:00:00Z');
const MINUTE = 60 * 1000;

function fakeKv(initial) {
  const store = new Map(initial ? [[STATE_KEY, JSON.stringify(initial)]] : []);
  return {
    store,
    async get(key, type) {
      const value = store.get(key) ?? null;
      return type === 'json' && value ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, value);
    }
  };
}

function snapshot(title = 'PoP offline') {
  return {
    timestamp: new Date(NOW).toISOString(),
    providers: [{ name: 'Cloudflare', status: 'major', description: 'Partial Outage', items: [{ title, detail: '', severity: 'major', updatedAt: new Date(NOW).toISOString() }] }]
  };
}

let requests;
let webhookStatus;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  requests = [];
  webhookStatus = 200;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(webhookStatus === 200 ? '{}' : 'rate limited', { status: webhookStatus });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const env = kv => ({ CDN_STATUS_KV: kv, TRMNL_PLUGIN_UUID: 'plugin-uuid', HEARTBEAT_MINUTES: '30' });

test('first run pushes merge variables and saves state', async () => {
  const kv = fakeKv();
  const result = await pushIfNeeded(env(kv), snapshot(), { now: NOW });

  assert.equal(result.pushed, true);
  assert.equal(result.reason, 'changed');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://usetrmnl.com/api/custom_plugins/plugin-uuid');
  assert.equal(requests[0].body.merge_variables.providers[0].items[0].t, 'PoP offline');
  assert.equal(JSON.parse(kv.store.get(STATE_KEY)).pushedAt, NOW);
});

test('skips the push when nothing changed and the heartbeat is not due', async () => {
  const kv = fakeKv();
  await pushIfNeeded(env(kv), snapshot(), { now: NOW });
  const result = await pushIfNeeded(env(kv), snapshot(), { now: NOW + 10 * MINUTE });

  assert.deepEqual(result, { pushed: false, reason: 'unchanged' });
  assert.equal(requests.length, 1);
});

test('pushes a heartbeat once HEARTBEAT_MINUTES have passed without changes', async () => {
  const kv = fakeKv();
  await pushIfNeeded(env(kv), snapshot(), { now: NOW });
  const result = await pushIfNeeded(env(kv), snapshot(), { now: NOW + 30 * MINUTE });

  assert.equal(result.reason, 'heartbeat');
  assert.equal(requests.length, 2);
});

test('pushes immediately when the displayed status changes', async () => {
  const kv = fakeKv();
  await pushIfNeeded(env(kv), snapshot('PoP offline'), { now: NOW });
  const result = await pushIfNeeded(env(kv), snapshot('PoP restored'), { now: NOW + 5 * MINUTE });

  assert.equal(result.reason, 'changed');
  assert.equal(requests.length, 2);
});

test('does not save state when the webhook fails, so the next run retries', async () => {
  const kv = fakeKv();
  webhookStatus = 429;
  const failed = await pushIfNeeded(env(kv), snapshot(), { now: NOW });

  assert.equal(failed.pushed, false);
  assert.match(failed.error, /HTTP 429/);
  assert.equal(kv.store.has(STATE_KEY), false);

  webhookStatus = 200;
  const retried = await pushIfNeeded(env(kv), snapshot(), { now: NOW + 5 * MINUTE });
  assert.equal(retried.pushed, true);
});

test('reports a missing plugin UUID without calling TRMNL', async () => {
  const result = await pushIfNeeded({ CDN_STATUS_KV: fakeKv() }, snapshot(), { now: NOW });
  assert.equal(result.pushed, false);
  assert.match(result.error, /TRMNL_PLUGIN_UUID/);
  assert.equal(requests.length, 0);
});
