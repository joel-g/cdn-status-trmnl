// Renders the same Liquid templates TRMNL uses, inside TRMNL's own CSS, for browser preview.

import { Liquid } from 'liquidjs';

const engine = new Liquid();

/** Mashup wrapper class for half/quadrant layouts; `slots` = how many views share the screen. */
export const LAYOUTS = {
  full: { mashup: null, slots: 1 },
  half_horizontal: { mashup: 'mashup--1Tx1B', slots: 2 },
  half_vertical: { mashup: 'mashup--1Lx1R', slots: 2 },
  quadrant: { mashup: 'mashup--2x2', slots: 4 }
};

export function renderMarkup(template, mergeVariables) {
  return engine.parseAndRender(template, mergeVariables);
}

function escapeAttribute(html) {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export async function renderScreen(template, mergeVariables, layout) {
  const { mashup, slots } = LAYOUTS[layout];
  const view = `<div class="view view--${layout}">${await renderMarkup(template, mergeVariables)}</div>`;
  const empty = `<div class="view view--${layout}"></div>`;
  const body = mashup ? `<div class="mashup ${mashup}">${view}${empty.repeat(slots - 1)}</div>` : view;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="https://usetrmnl.com/css/latest/plugins.css">
  <script src="https://usetrmnl.com/js/latest/plugins.js"></script>
  <style>body{margin:0}</style>
</head>
<body class="environment trmnl">
  <div class="screen">${body}</div>
</body>
</html>`;
}

export async function renderPreviewPage(templates, mergeVariables, layouts = Object.keys(LAYOUTS)) {
  const frames = await Promise.all(
    layouts.map(async layout => `
    <figure>
      <figcaption>${layout}</figcaption>
      <iframe width="800" height="480" srcdoc="${escapeAttribute(await renderScreen(templates[layout], mergeVariables, layout))}"></iframe>
    </figure>`)
  );

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CDN Status - TRMNL Preview</title>
  <style>
    body { background: #1a1a1a; color: #aaa; font-family: sans-serif; margin: 0; padding: 24px;
           display: flex; flex-wrap: wrap; gap: 24px; justify-content: center; }
    figure { margin: 0; }
    figcaption { font-size: 12px; margin-bottom: 8px; }
    iframe { border: 0; background: #fff; filter: grayscale(100%); display: block; }
  </style>
</head>
<body>${frames.join('')}
</body>
</html>`;
}
