# CDN Status TRMNL Plugin

A Cloudflare Worker that provides a [TRMNL](https://usetrmnl.com/) plugin displaying real-time status from major CDN providers:

- **Cloudflare** - via JSON API
- **Fastly** - via HTML scraping
- **Akamai** - via JSON API

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Login to Cloudflare (first time only):
   ```bash
   npx wrangler login
   ```

3. Run locally:
   ```bash
   npm run dev
   ```

4. Deploy to Cloudflare:
   ```bash
   npm run deploy
   ```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Health check |
| `GET /trmnl/plugin` | TRMNL webhook endpoint (returns HTML) |
| `GET /api/status` | JSON API for debugging |
| `GET /preview` | Browser preview with e-ink styling |

## TRMNL Setup

1. Deploy this worker to get your URL (e.g., `https://cdn-status-trmnl.your-subdomain.workers.dev`)
2. In TRMNL dashboard, go to **Plugins** → **Private Plugin**
3. Set the webhook URL to: `https://your-worker-url/trmnl/plugin`
4. Set polling interval (recommended: 15 minutes)
5. Save and add to your screen rotation

## Caching

Status data is cached for 5 minutes to avoid excessive API calls.
