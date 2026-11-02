# CDN Status TRMNL Plugin

A Cloudflare Worker that powers a [TRMNL](https://usetrmnl.com/) private plugin showing live status for:

- **Cloudflare** - Statuspage JSON API
- **Akamai** - Statuspage JSON API
- **Fastly** - StatusCast RSS feed

## How it works

```
cron (*/5) ──> fetch 3 status pages ──> normalise ──> merge_variables ──> TRMNL webhook
                                                          │
                                   TRMNL renders templates/*.liquid on the device
```

- The worker pushes **data, not HTML**. The layout lives in the Liquid templates you paste into TRMNL, which keeps the payload under the 2kb webhook limit and leaves room for several incidents per provider.
- A push happens when the displayed status **changes**, or as a **heartbeat** every `HEARTBEAT_MINUTES` (default 30) so the footer time and the "2h ago" ages stay current.
- State is saved to KV **only after TRMNL accepts the push**, so failed pushes retry on the next run.
- Templates exist for every TRMNL layout: `full`, `half_horizontal`, `half_vertical`, `quadrant` (mashups work).

### What is shown

| Provider | Items |
|---|---|
| Cloudflare / Akamai | Unresolved incidents (with status: investigating, monitoring, …), in-progress maintenance, and non-operational components grouped by status, e.g. `Major outage · 22 components` with PoP codes `OKC, MEX, …` |
| Fastly | One item per incident (latest update wins), unresolved, updated in the last 7 days; severity from the title (outage, maintenance, other) |

Items are sorted by severity, then recency. Columns show as many whole items as fit, and the header shows the total (`5 active`).

## Setup

Requires Node 22+ (`nvm use`).

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CDN_STATUS_KV   # put the id in wrangler.toml
npx wrangler secret put TRMNL_PLUGIN_UUID        # from the TRMNL private plugin
npx wrangler secret put TRIGGER_TOKEN            # optional, enables POST /trigger
npm run deploy
```

### TRMNL

1. **Plugins → Private Plugin → New**, strategy **Webhook**, and copy the plugin UUID.
2. **Edit Markup**: paste each template into its tab. Get them from `templates/` or from the deployed worker:
   `https://<worker>/templates/full.liquid`, `.../half_horizontal.liquid`, `.../half_vertical.liquid`, `.../quadrant.liquid`
3. Deploy the worker. The first cron run pushes data (or call `/trigger`, below).

## Configuration (`wrangler.toml` `[vars]`)

| Variable | Default | Purpose |
|---|---|---|
| `TIMEZONE` | `UTC` (repo sets `America/Chicago`) | IANA timezone for the footer "Checked" time |
| `HEARTBEAT_MINUTES` | `30` | Maximum time between pushes |
| `TRMNL_MAX_PAYLOAD_BYTES` | `2000` | Webhook body budget; raise to `5000` on TRMNL+ |

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Health check |
| `GET /api/status` | Normalised status snapshot (live) |
| `GET /api/payload` | Exact `merge_variables` that would be pushed, plus byte size |
| `GET /preview[?layout=full]` | Renders the real templates with TRMNL's CSS (all layouts by default) |
| `GET /templates/{layout}.liquid` | Raw template for pasting into TRMNL |
| `POST /trigger` | Force a push. Requires `Authorization: Bearer $TRIGGER_TOKEN`; disabled if unset |

```bash
curl -X POST -H "Authorization: Bearer $TRIGGER_TOKEN" https://<worker>/trigger
```

## Development

```bash
npm test        # node:test suite (parsers, payload budget, push logic, templates, auth)
npm run dev     # wrangler dev; curl "http://localhost:8787/__scheduled" to run the cron
npm run build   # bundle check without deploying
```

> Behind a corporate HTTPS proxy, `wrangler dev` (workerd) cannot reach the status pages and every provider shows "Status unavailable". Deployed workers are unaffected.

## Layout

```
src/
  index.js              routes + cron handler
  sources/              status page fetchers and pure parsers
  payload.js            merge_variables builder, byte budget, change hash
  trmnl.js              webhook push + change/heartbeat decision
  preview.js            renders templates with liquidjs for /preview
  auth.js               bearer token check
templates/*.liquid      TRMNL markup, one per layout
test/                   node:test suites
```
