// Builds the TRMNL `merge_variables` payload from a status snapshot.
//
// Shape (item keys are short because they repeat and count against the byte limit):
//   providers[]: { name, status, desc, items[]: { t: title, m: detail, k: severity, u: epoch seconds }, more }
//   checked_at:  preformatted local time of the check, e.g. "6:14 PM"
//   checked_ts:  epoch seconds of the check

import { rank, toMs, truncate } from './util.js';

export const MAX_ITEMS_PER_PROVIDER = 5;
const TITLE_MAX = 80;
const DETAIL_MAX = 90;

export function readConfig(env = {}) {
  return {
    timeZone: env.TIMEZONE || 'UTC',
    heartbeatMs: (Number(env.HEARTBEAT_MINUTES) || 30) * 60 * 1000,
    maxBytes: Number(env.TRMNL_MAX_PAYLOAD_BYTES) || 2000
  };
}

export function formatTime(date, timeZone) {
  const options = { hour: 'numeric', minute: '2-digit' };
  try {
    return date.toLocaleTimeString('en-US', { ...options, timeZone });
  } catch {
    return `${date.toLocaleTimeString('en-US', { ...options, timeZone: 'UTC' })} UTC`;
  }
}

/** Size of the webhook request body in bytes. */
export function payloadBytes(mergeVariables) {
  return new TextEncoder().encode(JSON.stringify({ merge_variables: mergeVariables })).length;
}

/** Drops the least important trailing item (lowest severity, from the busiest provider) until it fits. */
function fitToBudget(vars, maxBytes) {
  while (payloadBytes(vars) > maxBytes) {
    const candidates = vars.providers.filter(p => p.items.length > 0);
    if (candidates.length === 0) return;
    const victim = candidates.reduce((best, p) => {
      const diff = rank(p.items.at(-1).k) - rank(best.items.at(-1).k);
      return diff < 0 || (diff === 0 && p.items.length > best.items.length) ? p : best;
    });
    victim.items.pop();
    victim.more += 1;
  }
}

export function buildPayload(snapshot, { timeZone = 'UTC', maxBytes = 2000 } = {}) {
  const checked = new Date(snapshot.timestamp);
  const vars = {
    providers: snapshot.providers.map(p => ({
      name: p.name,
      status: p.status,
      desc: p.description,
      items: p.items.slice(0, MAX_ITEMS_PER_PROVIDER).map(item => ({
        t: truncate(item.title, TITLE_MAX),
        m: truncate(item.detail ?? '', DETAIL_MAX),
        k: item.severity,
        u: Math.floor(toMs(item.updatedAt) / 1000)
      })),
      more: Math.max(0, p.items.length - MAX_ITEMS_PER_PROVIDER)
    })),
    checked_at: formatTime(checked, timeZone),
    checked_ts: Math.floor(checked.getTime() / 1000)
  };
  fitToBudget(vars, maxBytes);
  return vars;
}

/** Hash of what is displayed, ignoring timestamps, so only real status changes count. */
export async function statusHash(vars) {
  const relevant = vars.providers.map(({ items, ...p }) => ({ ...p, items: items.map(({ u, ...item }) => item) }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(relevant)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
