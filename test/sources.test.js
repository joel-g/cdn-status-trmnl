import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchAllStatuses } from '../src/sources/index.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/fastly-summary.json', import.meta.url)));
const now = new Date('2026-11-03T17:00:00Z');

function mockSources(t, fastlyResponse) {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(url).hostname === 'www.fastlystatus.com') {
      assert.equal(url, 'https://www.fastlystatus.com/summary.json');
      assert.equal(options.headers.Accept, 'application/json');
      assert.match(options.headers['User-Agent'], /^Mozilla\/5\.0 /);
      return fastlyResponse();
    }
    assert.equal(options.headers['User-Agent'], 'cdn-status-trmnl');
    return Response.json({ status: { indicator: 'none' }, incidents: [], components: [], scheduled_maintenances: [] });
  });
  t.mock.method(console, 'error', () => {});
}

test('fetches Fastly JSON with Mozilla while keeping other provider requests unchanged', async t => {
  mockSources(t, () => Response.json(fixture));
  const result = await fetchAllStatuses(now);
  const fastly = result.providers.find(p => p.name === 'Fastly');
  assert.equal(fastly.status, 'maint');
  assert.equal(fastly.items.length, 4);
  assert.ok(result.providers.filter(p => p.name !== 'Fastly').every(p => p.status === 'ok'));
});

test('HTTP 403, HTML, empty and invalid JSON responses become provider errors', async t => {
  for (const makeResponse of [
    () => new Response('Invalid request blocked (v1)', { status: 403 }),
    () => new Response('<html>Error</html>'),
    () => new Response(''),
    () => Response.json({}),
    () => Response.json({ ...fixture, Status: 'Unexpected' })
  ]) {
    await t.test('rejects invalid upstream response', async t => {
      mockSources(t, makeResponse);
      const result = await fetchAllStatuses(now);
      const fastly = result.providers.find(p => p.name === 'Fastly');
      assert.equal(fastly.status, 'error');
      assert.match(fastly.description, /^Status unavailable/);
      assert.deepEqual(fastly.items, []);
    });
  }
});
