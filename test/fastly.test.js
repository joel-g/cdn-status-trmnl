import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatusCastSummary } from '../src/sources/fastly.js';

const NOW = Date.parse('2026-11-03T17:00:00Z');
const provider = { name: 'Fastly', pageUrl: 'https://www.fastlystatus.com' };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/fastly-summary.json', import.meta.url)));
const post = overrides => ({
  Id: 1, Date: '2026-11-03T12:00:00', IsPublished: true,
  PostType: 'Investigating', NewComponentStatus: 'DegradedPerformance',
  Text: '<p>Engineers are investigating.</p>', ...overrides
});
const incident = overrides => ({
  Id: 1, Title: 'Elevated errors', Status: 'InProgress', IncidentType: 'ServiceUnavailable',
  StartDate: '2026-11-03T10:00:00', Posts: [post()], ...overrides
});
const summary = overrides => ({ Status: 'Available', StatusText: 'All Systems Operational', UnresolvedIncidents: [], UpcomingIncidents: [], ...overrides });
const parse = data => parseStatusCastSummary(data, provider, { now: NOW });

test('maps page status independently of incident titles and preserves status text', () => {
  for (const [status, expected] of Object.entries({ Available: 'ok', Unavailable: 'major', DegradedPerformance: 'minor', Maintenance: 'maint', Informational: 'info', Monitoring: 'minor' })) {
    const result = parse(summary({ Status: status, StatusText: 'Provider description' }));
    assert.equal(result.status, expected);
    assert.equal(result.description, 'Provider description');
  }
  assert.deepEqual(parse(summary()).items, []);
});

test('real summary keeps all four active events, including September maintenance, and excludes upcoming work', () => {
  // Projection of Fastly's live summary on 2026-11-03, retaining lifecycle fields.
  const result = parse(fixture);
  assert.equal(result.status, 'maint');
  assert.equal(result.items.length, 4);
  assert.equal(result.items[0].title, 'Changes to Fastly IP Address Space');
  assert.equal(result.items[0].updatedAt, '2026-09-14T17:56:00.000Z');
  assert.equal(result.items[0].severity, 'maint');
  assert.ok(result.items.slice(1).every(item => item.severity === 'info'));
  assert.ok(result.items.some(item => item.title.startsWith('Domainr:')));
  assert.ok(result.items.every(item => !item.title.includes('Manchester')));
});

test('uses latest published update, ignoring unpublished and future posts', () => {
  const result = parse(summary({ UnresolvedIncidents: [incident({ Posts: [
    post({ Id: 3, Date: '2026-11-03T14:00:00', NewComponentStatus: 'Informational', IsPublished: false }),
    post({ Id: 4, Date: '2026-11-04T14:00:00', PostType: 'Closed', NewComponentStatus: 'Available' }),
    post({ Id: 2, Date: '2026-11-03T13:00:00', PostType: 'Monitoring', NewComponentStatus: 'Monitoring', Text: '<p>Fix &amp; recovery.</p>' }),
    post({ NewComponentStatus: 'Unavailable' })
  ] })] }));
  assert.equal(result.items[0].severity, 'minor');
  assert.equal(result.items[0].updatedAt, '2026-11-03T13:00:00.000Z');
  assert.equal(result.items[0].detail, 'Monitoring · Fix & recovery.');
});

test('excludes closed, ended and future events using structured lifecycle fields', () => {
  const result = parse(summary({ UnresolvedIncidents: [
    incident({ Status: 'Closed' }),
    incident({ Status: 'Future' }),
    incident({ EndDate: '2026-11-03T15:00:00' }),
    incident({ StartDate: '2026-11-04T10:00:00' }),
    incident({ Posts: [post({ PostType: 'Closed' })] }),
    incident({ Title: 'Still monitoring', Posts: [post({ Text: 'During this incident, a subsystem has been resolved. Monitoring continues.', PostType: 'Monitoring' })] })
  ] }));
  assert.deepEqual(result.items.map(item => item.title), ['Still monitoring']);
});

test('classifies by component status instead of outage words, and sorts by severity then recency', () => {
  const result = parse(summary({ UnresolvedIncidents: [
    incident({ Title: 'Outage retrospective advisory', IncidentType: 'Informational', Posts: [post({ NewComponentStatus: 'Informational' })] }),
    incident({ Title: 'Capacity work', IncidentType: 'ScheduledMaintenance', Posts: [post({ NewComponentStatus: 'Maintenance' })] }),
    incident({ Title: 'Traffic rerouting', Posts: [post({ NewComponentStatus: 'Unavailable' })] }),
    incident({ Title: 'Older degradation', Posts: [post()] }),
    incident({ Title: 'Newer degradation', Posts: [post({ Date: '2026-11-03T13:00:00' })] })
  ] }));
  assert.deepEqual(result.items.map(item => [item.title, item.severity]), [
    ['Traffic rerouting', 'major'], ['Newer degradation', 'minor'], ['Older degradation', 'minor'],
    ['Capacity work', 'maint'], ['Outage retrospective advisory', 'info']
  ]);
});

test('falls back to structured incident type and start time when there are no published posts', () => {
  const result = parse(summary({ UnresolvedIncidents: [incident({ IncidentType: 'ScheduledMaintenance', Posts: [] })] }));
  assert.equal(result.items[0].severity, 'maint');
  assert.equal(result.items[0].updatedAt, '2026-11-03T10:00:00.000Z');
});

test('interprets zone-less dates as UTC even outside UTC and respects explicit offsets', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const result = parse(summary({ UnresolvedIncidents: [incident({ Posts: [post({ Date: '2026-11-03T05:00:00-08:00' }), post()] })] }));
    assert.equal(result.items[0].updatedAt, '2026-11-03T13:00:00.000Z');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('rejects malformed and unknown data instead of reporting operational', () => {
  for (const data of [null, {}, '', '<html>error</html>', summary({ Status: 'Unexpected' }), summary({ UnresolvedIncidents: null }),
    summary({ UnresolvedIncidents: [incident({ Status: 'Unexpected' })] }),
    summary({ UnresolvedIncidents: [incident({ Posts: [post({ Date: 'invalid' })] })] }),
    summary({ UnresolvedIncidents: [incident({ Posts: [post({ NewComponentStatus: 'Unexpected' })] })] })]) {
    assert.throws(() => parse(data), /Invalid Fastly summary/);
  }
});
