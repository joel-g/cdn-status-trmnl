# CDN Status TRMNL Plugin

A Cloudflare Worker that provides a [TRMNL](https://usetrmnl.com/) plugin displaying real-time status from major CDN providers:

- **Cloudflare** - via JSON API
- **Fastly** - via RSS feed
- **Akamai** - via JSON API

## Features

- **Webhook-based updates** - Only pushes to TRMNL when status changes (efficient)
- **5-minute cron checks** - Regularly monitors all CDN status pages
- **Smart incident prioritization** - Sorts by severity (major > minor > none), then by recency
- **Relative timestamps** - Shows how recent each incident is (e.g., "2h ago", "1d ago")
- **Compact payload** - Optimized markup stays under TRMNL's 2kb limit

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Login to Cloudflare (first time only):
   ```bash
   npx wrangler login
   ```

3. Create KV namespace:
   ```bash
   npx wrangler kv namespace create CDN_STATUS_KV
   ```
   Update `wrangler.toml` with the returned namespace ID.

4. Set your TRMNL plugin UUID as a secret:
   ```bash
   npx wrangler secret put TRMNL_PLUGIN_UUID
   ```
   (Get this from your TRMNL Private Plugin settings)

5. Run locally:
   ```bash
   npm run dev
   ```

6. Deploy to Cloudflare:
   ```bash
   npm run deploy
   ```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Health check |
| `GET /api/status` | JSON API for debugging |
| `GET /preview` | Browser preview with e-ink styling |
| `GET /trigger` | Manually trigger a status check and webhook push |

## TRMNL Setup

1. In TRMNL dashboard, go to **Plugins** → **Private Plugin**
2. Select **Webhook** strategy (not polling)
3. Copy your plugin UUID
4. Deploy this worker and set the `TRMNL_PLUGIN_UUID` secret
5. The worker will automatically push updates every 5 minutes when status changes

## Architecture

- **Cron trigger** (`*/5 * * * *`) - Checks CDN status every 5 minutes
- **KV Storage** - Stores hash of last known status to detect changes
- **Webhook push** - Only sends to TRMNL when status actually changes
- **Change detection** - Compares provider status, descriptions, and incident counts

## Caching

Status data is cached for 5 minutes to avoid excessive API calls.
