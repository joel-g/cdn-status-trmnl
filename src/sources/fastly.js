// Fastly's StatusCast /summary.json API. Status fields drive classification;
// HTML in post bodies is used only for a short, plain-text description.

import { compareItems, htmlToText, truncate } from '../util.js';

export const FASTLY_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const COMPONENT_STATUS = {
  Available: 'ok',
  Unavailable: 'major',
  DegradedPerformance: 'minor',
  Maintenance: 'maint',
  Informational: 'info',
  Investigating: 'minor',
  Identified: 'minor',
  Monitoring: 'minor'
};
const INCIDENT_SEVERITY = { ScheduledMaintenance: 'maint', ServiceUnavailable: 'minor', Informational: 'info' };
const DESCRIPTION = {
  ok: 'All Systems Operational', major: 'Major Outage', minor: 'Active Incident',
  maint: 'Maintenance', info: 'Informational'
};
const POST_LABEL = { Investigating: 'Investigating', Identified: 'Identified', Monitoring: 'Monitoring' };

function invalid(field) {
  throw new Error(`Invalid Fastly summary: ${field}`);
}

function componentSeverity(status) {
  if (!Object.hasOwn(COMPONENT_STATUS, status)) invalid('unknown component status');
  return COMPONENT_STATUS[status];
}

/** StatusCast's zone-less dates are UTC, as displayed on Fastly's status page. */
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) invalid('invalid timestamp');
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const ms = Date.parse(zoned);
  if (!Number.isFinite(ms)) invalid('invalid timestamp');
  return ms;
}

function latestPost(posts, now) {
  if (!Array.isArray(posts)) invalid('missing incident posts');
  return posts
    .filter(post => {
      if (!post || typeof post.IsPublished !== 'boolean') invalid('invalid incident post');
      return post.IsPublished;
    })
    .map(post => ({ post, time: timestamp(post.Date) }))
    .filter(({ time }) => time <= now)
    .sort((a, b) => b.time - a.time || (b.post.Id ?? 0) - (a.post.Id ?? 0))[0];
}

function incidentItem(incident, now) {
  if (!incident || typeof incident.Title !== 'string' || !incident.Title.trim()) invalid('missing incident title');
  if (!['InProgress', 'Closed', 'Future'].includes(incident.Status)) invalid('unknown incident status');
  if (incident.Status !== 'InProgress') return null;
  const started = timestamp(incident.StartDate);
  if (started > now || (incident.EndDate && timestamp(incident.EndDate) <= now)) return null;
  const latest = latestPost(incident.Posts, now);
  if (latest?.post.PostType === 'Closed') return null;

  if (!Object.hasOwn(INCIDENT_SEVERITY, incident.IncidentType)) invalid('unknown incident type');
  const severity = latest?.post.NewComponentStatus == null
    ? INCIDENT_SEVERITY[incident.IncidentType]
    : componentSeverity(latest.post.NewComponentStatus);
  if (latest?.post.Text != null && typeof latest.post.Text !== 'string') invalid('invalid post text');
  const text = htmlToText(latest?.post.Text ?? '');
  const label = POST_LABEL[latest?.post.PostType];
  const detail = truncate(label ? `${label}${text ? ` · ${text}` : ''}` : text || DESCRIPTION[severity], 120);
  return {
    title: incident.Title.trim(),
    detail,
    severity,
    updatedAt: new Date(latest?.time ?? started).toISOString()
  };
}

export function parseStatusCastSummary(data, provider, { now = Date.now() } = {}) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.UnresolvedIncidents)
      || !Array.isArray(data.UpcomingIncidents)) invalid('missing incident arrays');
  const status = componentSeverity(data.Status);
  if (data.StatusText != null && typeof data.StatusText !== 'string') invalid('invalid status text');
  // The summary's active list is authoritative; no age cutoff or wording guesses.
  // UpcomingIncidents is intentionally excluded from the current status display.
  const items = data.UnresolvedIncidents.map(incident => incidentItem(incident, now))
    .filter(Boolean).sort(compareItems);
  return {
    name: provider.name,
    url: provider.pageUrl,
    status,
    description: data.StatusText?.trim() || DESCRIPTION[status],
    items
  };
}
