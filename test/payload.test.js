import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, formatTime, payloadBytes, readConfig, statusHash } from '../src/payload.js';

const item = (title, severity, updatedAt = '2026-11-02T12:00:00Z') => ({ title, detail: 'Investigating', severity, updatedAt });

function snapshot(itemsPerProvider = []) {
  return {
    timestamp: '2026-11-03T00:14:00Z',
    providers: ['Cloudflare', 'Akamai', 'Fastly'].map((name, i) => ({
      name,
      status: 'minor',
      description: 'Degraded Performance',
      items: itemsPerProvider[i] ?? []
    }))
  };
}

test('converts items to compact keys with epoch seconds', () => {
  const vars = buildPayload(snapshot([[item('PoP offline', 'major', '2026-11-02T12:00:00Z')]]));
  assert.deepEqual(vars.providers[0], {
    name: 'Cloudflare',
    status: 'minor',
    desc: 'Degraded Performance',
    items: [{ t: 'PoP offline', m: 'Investigating', k: 'major', u: Date.parse('2026-11-02T12:00:00Z') / 1000 }],
    more: 0
  });
});

test('formats the check time in the configured timezone', () => {
  assert.equal(buildPayload(snapshot(), { timeZone: 'America/Chicago' }).checked_at, '6:14 PM');
  assert.equal(formatTime(new Date('2026-11-03T00:14:00Z'), 'Not/AZone'), '12:14 AM UTC');
});

test('stays within the byte budget by dropping the least severe items and counting them in "more"', () => {
  const long = 'x'.repeat(70);
  const items = [
    [item(`${long} a`, 'major'), item(`${long} b`, 'major'), item(`${long} c`, 'major')],
    [item(`${long} d`, 'info'), item(`${long} e`, 'info'), item(`${long} f`, 'info')],
    [item(`${long} g`, 'minor'), item(`${long} h`, 'minor'), item(`${long} i`, 'minor')]
  ];
  const vars = buildPayload(snapshot(items), { maxBytes: 1200 });

  assert.ok(payloadBytes(vars) <= 1200, `payload is ${payloadBytes(vars)} bytes`);
  const [cloudflare, akamai] = vars.providers;
  assert.equal(cloudflare.items.length, 3, 'major items are kept');
  assert.ok(akamai.items.length < 3, 'info items are dropped first');
  const shown = vars.providers.reduce((n, p) => n + p.items.length, 0);
  const hidden = vars.providers.reduce((n, p) => n + p.more, 0);
  assert.equal(shown + hidden, 9, 'every dropped item is counted');
});

test('caps items per provider and truncates long titles', () => {
  const many = Array.from({ length: 8 }, (_, i) => item(`Incident ${i} ${'y'.repeat(100)}`, 'minor'));
  const vars = buildPayload(snapshot([many]), { maxBytes: 10000 });
  assert.equal(vars.providers[0].items.length, 5);
  assert.equal(vars.providers[0].more, 3);
  assert.equal(vars.providers[0].items[0].t.length, 80);
  assert.ok(vars.providers[0].items[0].t.endsWith('…'));
});

test('status hash ignores timestamps but changes when displayed content changes', async () => {
  const base = await statusHash(buildPayload(snapshot([[item('PoP offline', 'major', '2026-11-02T12:00:00Z')]])));
  const later = await statusHash(buildPayload({ ...snapshot([[item('PoP offline', 'major', '2026-11-02T13:30:00Z')]]), timestamp: '2026-11-03T05:00:00Z' }));
  const different = await statusHash(buildPayload(snapshot([[item('PoP restored', 'major')]])));
  assert.equal(base, later);
  assert.notEqual(base, different);
});

test('readConfig applies defaults and parses env strings', () => {
  assert.deepEqual(readConfig({}), { timeZone: 'UTC', heartbeatMs: 30 * 60000, maxBytes: 2000 });
  assert.deepEqual(readConfig({ TIMEZONE: 'Europe/Berlin', HEARTBEAT_MINUTES: '15', TRMNL_MAX_PAYLOAD_BYTES: '5000' }), {
    timeZone: 'Europe/Berlin',
    heartbeatMs: 15 * 60000,
    maxBytes: 5000
  });
});
