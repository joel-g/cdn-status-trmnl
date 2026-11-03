import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, readConfig, createClient, readMarkup, publish, loadSecrets } from '../scripts/deploy.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = { apiKey: 'test-secret', pluginId: '123', workerUrl: 'https://worker.example' };
const templates = Object.fromEntries(LAYOUTS.map(layout => [layout, `<div>${layout}</div>`]));
const payload = { bytes: 100, limit: 2000, merge_variables: { providers: [] } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('secrets file loads only TRMNL credentials and preserves explicit values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trmnl-secrets-test-'));
  try {
    const path = join(dir, 'secrets');
    await writeFile(path, 'export TRMNL_API_KEY="file-key"\nTRMNL_PLUGIN_SETTING_ID=123\nUNRELATED_SECRET=private\n');
    const env = { TRMNL_SECRETS_FILE: path, TRMNL_API_KEY: 'existing-key' };
    await loadSecrets(env);
    assert.equal(env.TRMNL_API_KEY, 'existing-key');
    assert.equal(env.TRMNL_PLUGIN_SETTING_ID, '123');
    assert.equal(env.UNRELATED_SECRET, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function fixture({ failLayout, mismatchLayout } = {}) {
  const calls = [];
  const saved = {};
  const client = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ path, method, body: options.body });
    if (method === 'PUT') {
      if (path.endsWith(failLayout || '!')) throw new Error('Upload failed');
      saved[path] = options.body.content;
      return { data: { success: true } };
    }
    if (method === 'GET') return { data: { markup: path.endsWith(mismatchLayout || '!') ? 'different' : saved[path] ?? null } };
    if (path === '/refreshes') return { data: { status: 'queued' } };
    return { error: null, merge_variables: options.body.merge_variables };
  };
  return { calls, client, templates, config, fetchImpl: async () => json(payload), log: () => {} };
}

test('deployment requires separate account credentials and a valid worker URL', () => {
  assert.throws(() => readConfig({}), /TRMNL_API_KEY/);
  const env = { TRMNL_API_KEY: 'key', TRMNL_PLUGIN_SETTING_ID: '123' };
  assert.throws(() => readConfig(env), /TRMNL_WORKER_URL/);
  assert.equal(readConfig({ ...env, TRMNL_WORKER_URL: 'https://worker.example' }).pluginId, '123');
  assert.throws(() => readConfig({ ...env, TRMNL_WORKER_URL: 'http://worker.example' }), /HTTPS/);
});

test('API client uses documented markup content and keeps credentials out of errors', async () => {
  const client = createClient(config, async (url, options) => {
    assert.equal(url, 'https://trmnl.com/api/plugin_settings/123/markup/markup_full');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { content: 'hello' });
    return json({ error: 'test-secret private data' }, 403);
  });
  await assert.rejects(client('/markup/markup_full', { method: 'PUT', body: { content: 'hello' } }), error => {
    assert.match(error.message, /Read and Content/);
    assert.ok(!error.message.includes('test-secret'));
    return true;
  });
});

test('preflight reads all four layouts, including empty layouts, without writes', async () => {
  const f = fixture();
  assert.deepEqual(await readMarkup(f.client), Object.fromEntries(LAYOUTS.map(layout => [layout, null])));
  assert.ok(f.calls.every(call => call.method === 'GET'));
  await assert.rejects(readMarkup(async () => ({ data: {} })), /Unexpected/);
});

test('publishes and verifies all layouts before sending data and requesting a render', async () => {
  const f = fixture();
  await publish(f);
  assert.deepEqual(f.calls.map(call => `${call.method} ${call.path}`), [
    ...LAYOUTS.flatMap(layout => [`PUT /markup/markup_${layout}`, `GET /markup/markup_${layout}`]),
    'POST /data', 'POST /refreshes'
  ]);
  assert.deepEqual(f.calls.at(-2).body, { merge_variables: payload.merge_variables });
});

test('an invalid worker payload prevents any TRMNL mutation', async () => {
  for (const response of [json({}, 500), json({ ...payload, bytes: 3000 }), json({})]) {
    const f = fixture();
    f.fetchImpl = async () => response;
    await assert.rejects(publish(f));
    assert.equal(f.calls.length, 0);
  }
});

test('failed or mismatched markup stops deployment before data and refresh', async () => {
  for (const options of [{ failLayout: 'half_horizontal' }, { mismatchLayout: 'half_horizontal' }]) {
    const f = fixture(options);
    await assert.rejects(publish(f));
    assert.ok(f.calls.every(call => call.path.startsWith('/markup/')));
    assert.ok(!f.calls.some(call => call.path.endsWith('quadrant')));
  }
});

test('a rejected data push prevents a render request', async () => {
  const f = fixture();
  const client = f.client;
  f.client = async (path, options) => {
    if (path === '/data') throw new Error('Data rejected');
    return client(path, options);
  };
  await assert.rejects(publish(f), /Data rejected/);
  assert.ok(!f.calls.some(call => call.path === '/refreshes'));
});
