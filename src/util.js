// Shared helpers: severity ordering, text cleanup, and fetch with timeout.

/** Item/provider severities, most severe first. */
export const SEVERITY_RANK = { major: 4, minor: 3, maint: 2, info: 1, ok: 0 };

export function rank(severity) {
  return SEVERITY_RANK[severity] ?? 0;
}

/** Most severe first, then most recently updated. */
export function compareItems(a, b) {
  return rank(b.severity) - rank(a.severity) || toMs(b.updatedAt) - toMs(a.updatedAt);
}

export function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text = '') {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Turns HTML or escaped HTML in provider descriptions into plain single-line text. */
export function htmlToText(html = '') {
  const unescaped = decodeEntities(html.replace(/^<!\[CDATA\[|\]\]>$/g, ''));
  return decodeEntities(unescaped.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function truncate(text = '', max) {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export function capitalize(text = '') {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export async function fetchWithTimeout(url, init = {}, timeoutMs = 10000) {
  const response = await fetch(url, {
    ...init,
    headers: { 'User-Agent': 'cdn-status-trmnl', ...init.headers },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}
