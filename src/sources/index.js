// Provider registry and fetch orchestration.

import { fetchWithTimeout } from '../util.js';
import { parseStatuspageSummary } from './statuspage.js';
import { FASTLY_USER_AGENT, parseStatusCastSummary } from './fastly.js';

export const PROVIDERS = [
  {
    name: 'Cloudflare',
    url: 'https://www.cloudflarestatus.com/api/v2/summary.json',
    pageUrl: 'https://www.cloudflarestatus.com',
    type: 'statuspage'
  },
  {
    name: 'Akamai',
    url: 'https://www.akamaistatus.com/api/v2/summary.json',
    pageUrl: 'https://www.akamaistatus.com',
    type: 'statuspage'
  },
  {
    name: 'Fastly',
    url: 'https://www.fastlystatus.com/summary.json',
    pageUrl: 'https://www.fastlystatus.com',
    type: 'statuscast'
  }
];

async function fetchProvider(provider, now) {
  try {
    if (provider.type === 'statuspage') {
      const response = await fetchWithTimeout(provider.url, { headers: { Accept: 'application/json' } });
      return parseStatuspageSummary(await response.json(), provider);
    }
    // Fastly currently rejects custom/absent user-agents on this public endpoint.
    // Keep the verified browser user-agent limited to Fastly.
    const response = await fetchWithTimeout(provider.url, {
      headers: { Accept: 'application/json', 'User-Agent': FASTLY_USER_AGENT }
    });
    return parseStatusCastSummary(await response.json(), provider, { now: now.getTime() });
  } catch (error) {
    console.error(`${provider.name} fetch failed:`, error);
    return {
      name: provider.name,
      url: provider.pageUrl,
      status: 'error',
      description: `Status unavailable (${error.message})`,
      items: []
    };
  }
}

export async function fetchAllStatuses(now = new Date()) {
  const providers = await Promise.all(PROVIDERS.map(p => fetchProvider(p, now)));
  return { timestamp: now.toISOString(), providers };
}
