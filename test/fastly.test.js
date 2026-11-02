import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatusCastRss } from '../src/sources/fastly.js';

const NOW = Date.parse('2026-11-02T18:00:00Z');
const provider = { name: 'Fastly', pageUrl: 'https://www.fastlystatus.com' };
const HOUR = 3600 * 1000;

/** One RSS <item> per update; `html` mimics StatusCast's double-escaped descriptions. */
function item({ incident, update, title, hoursAgo, html }) {
  const date = new Date(NOW - hoursAgo * HOUR).toUTCString();
  const escaped = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<item>
    <title>${title}</title>
    <description>${escaped}</description>
    <link>https://www.fastlystatus.com/incident/${incident}</link>
    <guid>/${incident}/${update}</guid>
    <pubDate>${date}</pubDate>
    <sc:customfields>[]</sc:customfields>
  </item>`;
}

const feed = items => `<?xml version="1.0"?><rss version="2.0" xmlns:sc="http://statuscast.com"><channel>${items.join('')}</channel></rss>`;
const parse = items => parseStatusCastRss(feed(items), provider, { now: NOW });

test('reports operational when there are no active incidents', () => {
  const result = parse([]);
  assert.equal(result.status, 'ok');
  assert.equal(result.description, 'All Systems Operational');
  assert.deepEqual(result.items, []);
});

test('uses only the latest update per incident, so a resolved incident disappears', () => {
  const result = parse([
    item({ incident: 1, update: 2, title: 'Kansas City (MCI) Rerouted Traffic', hoursAgo: 1, html: '<p>&#xA; This event has been resolved. &#xA;</p>' }),
    item({ incident: 1, update: 1, title: 'Kansas City (MCI) Rerouted Traffic', hoursAgo: 3, html: '<p>We are rerouting traffic away from MCI.</p>' })
  ]);
  assert.deepEqual(result.items, []);
});

test('shows one item per ongoing incident with the latest update text', () => {
  const result = parse([
    item({ incident: 2, update: 1, title: 'Elevated Errors &amp; Latency for McAllen (MFE)', hoursAgo: 4, html: '<p>Investigating.</p>' }),
    item({ incident: 2, update: 2, title: 'Elevated Errors &amp; Latency for McAllen (MFE)', hoursAgo: 2, html: '<span style="x">Engineers have identified the cause.</span> More soon.' })
  ]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Elevated Errors & Latency for McAllen (MFE)', 'decodes entities in titles');
  assert.equal(result.items[0].detail, 'Engineers have identified the cause.');
  assert.equal(result.items[0].updatedAt, new Date(NOW - 2 * HOUR).toISOString());
  assert.equal(result.status, 'minor');
});

test('keeps incidents ongoing for more than a day (regression: old 24h cutoff hid them)', () => {
  const result = parse([item({ incident: 3, update: 1, title: 'Osaka (ITM) with Possible Impact', hoursAgo: 40, html: 'Investigating.' })]);
  assert.equal(result.items.length, 1);
});

test('drops incidents older than the 7 day lookback, future announcements and retrospectives', () => {
  const result = parse([
    item({ incident: 4, update: 1, title: 'Domainr lookup issue', hoursAgo: 8 * 24, html: 'Investigating.' }),
    item({ incident: 5, update: 1, title: 'Upcoming change to geolocation values', hoursAgo: -24 * 30, html: 'On December 1...' }),
    item({ incident: 6, update: 1, title: 'Retrospective: Impacted Performance in Mumbai', hoursAgo: 5, html: 'Summary of the event.' })
  ]);
  assert.deepEqual(result.items, []);
});

test('classifies severity from the title and reports the worst one', () => {
  const result = parse([
    item({ incident: 7, update: 1, title: 'Hong Kong (HKG) Maintenance', hoursAgo: 1, html: 'Maintenance is in progress.' }),
    item({ incident: 8, update: 1, title: 'Compute Outage', hoursAgo: 2, html: 'Investigating.' })
  ]);
  assert.deepEqual(result.items.map(i => [i.title, i.severity]), [
    ['Compute Outage', 'major'],
    ['Hong Kong (HKG) Maintenance', 'maint']
  ]);
  assert.equal(result.status, 'major');
  assert.equal(result.description, 'Major Outage');
});
