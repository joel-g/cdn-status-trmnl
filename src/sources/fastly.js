// Parser for Fastly's StatusCast RSS feed.
// Each <item> is one *update*; items sharing a <link> belong to the same incident.

import { compareItems, decodeEntities, htmlToText, rank, truncate } from '../util.js';

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const RESOLVED_TEXT = /has been resolved|has been completed|has been cancel+ed|fully restored|has (?:now )?recovered|during this incident/i;

const STATUS_DESCRIPTION = {
  major: 'Major Outage',
  minor: 'Active Incident',
  maint: 'Maintenance In Progress',
  ok: 'All Systems Operational'
};

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return match ? match[1].trim() : '';
}

export function parseRssItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const pubDate = Date.parse(tag(item, 'pubDate'));
    return {
      title: htmlToText(tag(item, 'title')),
      link: decodeEntities(tag(item, 'link')),
      guid: tag(item, 'guid'),
      text: htmlToText(tag(item, 'description')),
      publishedAt: Number.isFinite(pubDate) ? pubDate : null
    };
  });
}

function incidentKey(update) {
  // guid is "/<incidentId>/<updateId>"
  return update.link || update.guid.split('/').filter(Boolean)[0] || update.title;
}

export function isResolved(update) {
  return /^retrospective/i.test(update.title) || RESOLVED_TEXT.test(update.text);
}

export function classifySeverity(title) {
  if (/maintenance/i.test(title)) return 'maint';
  if (/outage|unavailable|\bdown\b/i.test(title)) return 'major';
  return 'minor';
}

function firstSentence(text) {
  const match = text.match(/^.*?[.!?](?=\s|$)/);
  return truncate(match ? match[0] : text, 120);
}

/** Latest update per incident, keeping only unresolved incidents inside the lookback window. */
export function activeIncidents(updates, { now = Date.now(), lookbackMs = DEFAULT_LOOKBACK_MS } = {}) {
  const latest = new Map();
  for (const update of updates) {
    if (update.publishedAt === null || update.publishedAt > now) continue; // skip announcements of future work
    const key = incidentKey(update);
    if (!latest.has(key) || latest.get(key).publishedAt < update.publishedAt) latest.set(key, update);
  }

  return [...latest.values()].filter(u => u.publishedAt >= now - lookbackMs && !isResolved(u));
}

export function parseStatusCastRss(xml, provider, options = {}) {
  const items = activeIncidents(parseRssItems(xml), options)
    .map(update => ({
      title: update.title,
      detail: firstSentence(update.text),
      severity: classifySeverity(update.title),
      updatedAt: new Date(update.publishedAt).toISOString()
    }))
    .sort(compareItems);

  const status = items.reduce((worst, item) => (rank(item.severity) > rank(worst) ? item.severity : worst), 'ok');

  return {
    name: provider.name,
    url: provider.pageUrl,
    status,
    description: STATUS_DESCRIPTION[status],
    items
  };
}
