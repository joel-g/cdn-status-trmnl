import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatuspageSummary, shortComponentName } from '../src/sources/statuspage.js';

const provider = { name: 'Cloudflare', pageUrl: 'https://www.cloudflarestatus.com' };

function summary(overrides = {}) {
  return {
    page: { url: 'https://www.cloudflarestatus.com' },
    status: { indicator: 'none', description: 'All Systems Operational' },
    incidents: [],
    scheduled_maintenances: [],
    components: [],
    ...overrides
  };
}

const component = (name, status, extra = {}) => ({ name, status, group: false, updated_at: '2026-11-02T12:00:00Z', ...extra });

test('maps the page indicator to a provider status', () => {
  const result = parseStatuspageSummary(summary({ status: { indicator: 'critical', description: 'Major System Outage' } }), provider);
  assert.equal(result.status, 'major');
  assert.equal(result.description, 'Major System Outage');
  assert.deepEqual(result.items, []);
});

test('excludes resolved and postmortem incidents, keeps active ones with their status', () => {
  const result = parseStatuspageSummary(
    summary({
      incidents: [
        { name: 'Old outage', status: 'resolved', impact: 'major', updated_at: '2026-11-01T00:00:00Z' },
        { name: 'Postmortem', status: 'postmortem', impact: 'major', updated_at: '2026-11-01T00:00:00Z' },
        { name: 'Edge delivery issues', status: 'monitoring', impact: 'minor', updated_at: '2026-11-02T09:00:00Z' }
      ]
    }),
    provider
  );
  assert.deepEqual(result.items, [
    { title: 'Edge delivery issues', detail: 'Monitoring', severity: 'minor', updatedAt: '2026-11-02T09:00:00Z' }
  ]);
});

test('summarises many non-operational components per status with short PoP codes', () => {
  const result = parseStatuspageSummary(
    summary({
      components: [
        component('Wroclaw, Poland - (WRO)', 'major_outage'),
        component('Arica, Chile - (ARI)', 'major_outage', { updated_at: '2026-11-02T13:00:00Z' }),
        component('Europe', 'major_outage', { group: true }),
        component('Tokyo, Japan - (NRT)', 'degraded_performance'),
        component('Dallas, TX, United States - (DFW)', 'operational')
      ]
    }),
    provider
  );
  assert.deepEqual(
    result.items.map(i => [i.title, i.detail, i.severity]),
    [
      ['Major outage · 2 components', 'ARI, WRO', 'major'],
      ['Tokyo, Japan - (NRT)', 'Degraded', 'minor']
    ]
  );
  assert.equal(result.items[0].updatedAt, '2026-11-02T13:00:00Z', 'uses the most recent component update');
});

test('includes in-progress maintenance but not scheduled maintenance', () => {
  const result = parseStatuspageSummary(
    summary({
      scheduled_maintenances: [
        { name: 'DAC (Dhaka) on 2026-11-02', status: 'scheduled', updated_at: '2026-11-02T00:00:00Z' },
        { name: 'ICN (Seoul) on 2026-11-02', status: 'in_progress', updated_at: '2026-11-02T10:00:00Z' }
      ]
    }),
    provider
  );
  assert.deepEqual(result.items.map(i => [i.title, i.severity]), [['ICN (Seoul) on 2026-11-02', 'maint']]);
});

test('orders by severity, then incidents before component summaries', () => {
  const result = parseStatuspageSummary(
    summary({
      incidents: [
        { name: 'Security advisory', status: 'investigating', impact: 'none', updated_at: '2026-11-02T16:00:00Z' },
        { name: 'Dashboard errors', status: 'identified', impact: 'minor', updated_at: '2026-11-02T08:00:00Z' }
      ],
      components: [component('Wroclaw, Poland - (WRO)', 'major_outage'), component('Tokyo, Japan - (NRT)', 'degraded_performance')]
    }),
    provider
  );
  assert.deepEqual(result.items.map(i => i.title), [
    'Wroclaw, Poland - (WRO)',
    'Dashboard errors',
    'Tokyo, Japan - (NRT)',
    'Security advisory'
  ]);
});

test('shortComponentName keeps names without a code', () => {
  assert.equal(shortComponentName('Wroclaw, Poland - (WRO)'), 'WRO');
  assert.equal(shortComponentName('Content Delivery'), 'Content Delivery');
});
