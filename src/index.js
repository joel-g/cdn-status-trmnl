// CDN Status TRMNL Plugin
// Cloudflare Worker: checks Cloudflare, Akamai and Fastly status pages on a cron and
// pushes structured merge variables to a TRMNL private plugin (webhook strategy).

import { fetchAllStatuses } from './sources/index.js';
import { buildPayload, payloadBytes, readConfig } from './payload.js';
import { pushIfNeeded } from './trmnl.js';
import { LAYOUTS, renderPreviewPage } from './preview.js';
import { isAuthorized } from './auth.js';
import full from '../templates/full.liquid';
import halfHorizontal from '../templates/half_horizontal.liquid';
import halfVertical from '../templates/half_vertical.liquid';
import quadrant from '../templates/quadrant.liquid';

const TEMPLATES = { full, half_horizontal: halfHorizontal, half_vertical: halfVertical, quadrant };

const ENDPOINTS = ['/api/status', '/api/payload', '/preview', '/templates/{layout}.liquid', 'POST /trigger'];

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

async function handleTrigger(request, env) {
  if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);
  if (!env.TRIGGER_TOKEN) return json({ error: 'TRIGGER_TOKEN not configured; endpoint disabled' }, 403);
  if (!(await isAuthorized(request, env.TRIGGER_TOKEN))) return json({ error: 'Unauthorized' }, 401);

  const snapshot = await fetchAllStatuses();
  const result = await pushIfNeeded(env, snapshot, { force: true });
  return json(result, result.pushed ? 200 : 502);
}

async function handlePreview(url, env) {
  const layout = url.searchParams.get('layout');
  if (layout && !LAYOUTS[layout]) return new Response(`Unknown layout. Use one of: ${Object.keys(LAYOUTS).join(', ')}`, { status: 400 });

  const vars = buildPayload(await fetchAllStatuses(), readConfig(env));
  const html = await renderPreviewPage(TEMPLATES, vars, layout ? [layout] : undefined);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/') return json({ status: 'ok', service: 'cdn-status-trmnl', endpoints: ENDPOINTS });

    if (path === '/api/status') return json(await fetchAllStatuses());

    if (path === '/api/payload') {
      const config = readConfig(env);
      const vars = buildPayload(await fetchAllStatuses(), config);
      return json({ bytes: payloadBytes(vars), limit: config.maxBytes, merge_variables: vars });
    }

    if (path === '/preview') return handlePreview(url, env);

    const template = path.match(/^\/templates\/([a-z_]+)\.liquid$/);
    if (template) {
      const source = TEMPLATES[template[1]];
      return source
        ? new Response(source, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
        : new Response('Not Found', { status: 404 });
    }

    if (path === '/trigger') return handleTrigger(request, env);

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const snapshot = await fetchAllStatuses(new Date(event.scheduledTime));
        const result = await pushIfNeeded(env, snapshot, { now: event.scheduledTime });
        if (result.error) console.error('TRMNL push failed:', result);
        else console.log('Cron result:', result);
      })()
    );
  }
};
