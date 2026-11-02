import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAYOUTS, renderMarkup, renderPreviewPage } from '../src/preview.js';

const loadTemplates = async () =>
  Object.fromEntries(
    await Promise.all(Object.keys(LAYOUTS).map(async l => [l, await readFile(new URL(`../templates/${l}.liquid`, import.meta.url), 'utf8')]))
  );

const nowSeconds = () => Math.floor(Date.now() / 1000);

function vars() {
  return {
    checked_at: '6:14 PM',
    checked_ts: nowSeconds(),
    providers: [
      {
        name: 'Cloudflare',
        status: 'major',
        desc: 'Partial System Outage',
        items: [
          { t: 'Errors for <script>alert(1)</script> & KV', m: 'Investigating', k: 'major', u: nowSeconds() - 2 * 3600 - 120 },
          { t: 'Degraded · 31 components', m: 'NRT, KUL', k: 'minor', u: nowSeconds() - 3 * 86400 }
        ],
        more: 5
      },
      { name: 'Akamai', status: 'error', desc: 'Status unavailable (HTTP 503)', items: [], more: 0 },
      { name: 'Fastly', status: 'ok', desc: 'All Systems Operational', items: [], more: 0 }
    ]
  };
}

test('every layout escapes incident text and renders whole-number relative ages', async () => {
  const templates = await loadTemplates();
  for (const [layout, template] of Object.entries(templates)) {
    const html = await renderMarkup(template, vars());
    assert.ok(!html.includes('<script>'), `${layout}: raw HTML leaked`);
    assert.ok(html.includes('&lt;script&gt;'), `${layout}: escaped title missing`);
    assert.match(html, /\b2h\b/, `${layout}: relative age missing`);
    assert.doesNotMatch(html, /\d+\.\d+\s*(m|h|d)\b/, `${layout}: fractional age`);
  }
});

test('full layout shows totals, every provider and empty/error states', async () => {
  const { full } = await loadTemplates();
  const html = await renderMarkup(full, vars());

  assert.match(html, /7 active/, 'counts items not sent in the payload');
  assert.match(html, /cdn-head--major/);
  assert.match(html, /3d ago · NRT, KUL/);
  assert.match(html, /No data/);
  assert.match(html, /No active incidents/);
  assert.match(html, /Checked 6:14 PM/);
});

test('quadrant shows the top item with a hidden-count suffix', async () => {
  const { quadrant } = await loadTemplates();
  const html = await renderMarkup(quadrant, vars());
  assert.match(html, /2h · Errors for &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; KV \(\+6\)/);
});

test('preview page embeds each layout in a correctly escaped srcdoc', async () => {
  const page = await renderPreviewPage(await loadTemplates(), vars());
  assert.equal(page.match(/<iframe /g).length, 4);
  // Escaped once for HTML, then again for the attribute: the iframe still shows "&lt;script&gt;".
  assert.ok(page.includes('&amp;lt;script&amp;gt;'));
  assert.ok(page.includes('class=&quot;mashup mashup--2x2&quot;'));
});
