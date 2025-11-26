// CDN Status TRMNL Plugin
// Cloudflare Worker that fetches status from Cloudflare, Fastly, and Akamai

const CACHE_TTL = 300; // 5 minutes in seconds

const STATUS_SOURCES = {
  cloudflare: {
    name: 'Cloudflare',
    url: 'https://www.cloudflarestatus.com/api/v2/summary.json',
    type: 'json-summary'
  },
  akamai: {
    name: 'Akamai',
    url: 'https://www.akamaistatus.com/api/v2/summary.json',
    type: 'json-summary'
  },
  fastly: {
    name: 'Fastly',
    url: 'https://www.fastlystatus.com/rss',
    type: 'rss'
  }
};

// ============================================================================
// Status Fetchers
// ============================================================================

async function fetchJsonSummaryStatus(source) {
  try {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    
    // Get active incidents (non-resolved)
    const activeIncidents = (data.incidents || [])
      .filter(inc => inc.status !== 'resolved')
      .map(inc => ({
        name: inc.name,
        status: inc.status,
        impact: inc.impact,
        updatedAt: inc.updated_at,
        shortlink: inc.shortlink
      }));
    
    return {
      name: source.name,
      status: data.status.indicator,
      description: data.status.description,
      url: data.page.url,
      incidents: activeIncidents
    };
  } catch (error) {
    return {
      name: source.name,
      status: 'error',
      description: `Failed to fetch: ${error.message}`,
      url: source.url,
      incidents: []
    };
  }
}

async function fetchFastlyStatus(source) {
  try {
    const response = await fetch(source.url, {
      headers: {
        'Accept': 'application/rss+xml,application/xml,text/xml'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const xml = await response.text();
    
    // Parse RSS to check for recent active incidents (not resolved/retrospective)
    // Get items from the last 24 hours that aren't resolved
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    
    // Extract items from RSS
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    
    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1];
      
      // Extract title
      const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/);
      const title = titleMatch ? titleMatch[1].trim() : '';
      
      // Extract pubDate
      const dateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const pubDate = dateMatch ? new Date(dateMatch[1].trim()) : null;
      
      // Extract description
      const descMatch = itemXml.match(/<description>([\s\S]*?)<\/description>/);
      const description = descMatch ? descMatch[1].trim() : '';
      
      items.push({ title, pubDate, description });
    }
    
    // Filter for recent items (last 24h) that are NOT resolved/retrospective/maintenance completed
    const activeIncidents = items.filter(item => {
      if (!item.pubDate || item.pubDate.getTime() < oneDayAgo) return false;
      
      const lowerTitle = item.title.toLowerCase();
      const lowerDesc = item.description.toLowerCase();
      
      // Skip resolved/completed items
      if (lowerTitle.includes('retrospective') || 
          lowerDesc.includes('has been resolved') ||
          lowerDesc.includes('has been completed') ||
          lowerDesc.includes('has been cancelled')) {
        return false;
      }
      
      // Skip scheduled maintenance announcements (future)
      if (item.pubDate.getTime() > now) return false;
      
      return true;
    });
    
    // Determine status based on active incidents
    let status = 'none';
    let statusDescription = 'All Systems Operational';
    
    if (activeIncidents.length > 0) {
      // Check severity based on keywords
      const hasOutage = activeIncidents.some(i => 
        i.title.toLowerCase().includes('outage') || 
        i.description.toLowerCase().includes('outage') ||
        i.description.toLowerCase().includes('unavailable')
      );
      
      const hasElevatedErrors = activeIncidents.some(i =>
        i.title.toLowerCase().includes('elevated') ||
        i.title.toLowerCase().includes('impacted') ||
        i.description.toLowerCase().includes('elevated errors')
      );
      
      if (hasOutage) {
        status = 'major';
        statusDescription = 'Major Outage';
      } else if (hasElevatedErrors) {
        status = 'minor';
        statusDescription = 'Degraded Performance';
      } else {
        status = 'minor';
        statusDescription = 'Active Incident';
      }
    }
    
    return {
      name: source.name,
      status: status,
      description: statusDescription,
      url: 'https://www.fastlystatus.com',
      incidents: []
    };
  } catch (error) {
    return {
      name: source.name,
      status: 'error',
      description: `Failed to fetch: ${error.message}`,
      url: 'https://www.fastlystatus.com',
      incidents: []
    };
  }
}

async function fetchAllStatuses() {
  const results = await Promise.all([
    fetchJsonSummaryStatus(STATUS_SOURCES.cloudflare),
    fetchJsonSummaryStatus(STATUS_SOURCES.akamai),
    fetchFastlyStatus(STATUS_SOURCES.fastly)
  ]);
  
  return {
    timestamp: new Date().toISOString(),
    providers: results
  };
}

// ============================================================================
// Caching
// ============================================================================

async function getCachedStatuses(cacheKey, ctx) {
  const cache = caches.default;
  
  // Try to get from cache
  let response = await cache.match(cacheKey);
  if (response) {
    const data = await response.json();
    return { data, fromCache: true };
  }
  
  // Fetch fresh data
  const data = await fetchAllStatuses();
  
  // Store in cache
  const cacheResponse = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `s-maxage=${CACHE_TTL}`
    }
  });
  ctx.waitUntil(cache.put(cacheKey, cacheResponse));
  
  return { data, fromCache: false };
}

// ============================================================================
// TRMNL Template
// ============================================================================

function getStatusIcon(status) {
  switch (status) {
    case 'none':
    case 'operational':
      return '●'; // Green dot (will be shown as filled)
    case 'minor':
    case 'degraded':
      return '◐'; // Half circle
    case 'major':
    case 'critical':
      return '○'; // Empty circle (outline only)
    default:
      return '?';
  }
}

function getEmphasisLevel(status) {
  switch (status) {
    case 'none':
    case 'operational':
      return '1';
    case 'minor':
    case 'degraded':
      return '2';
    case 'major':
    case 'critical':
      return '3';
    default:
      return '1';
  }
}

function renderTrmnlPlugin(data) {
  const providersHtml = data.providers.map(provider => {
    const emphasisLevel = getEmphasisLevel(provider.status);
    const incidentText = provider.incidents && provider.incidents.length > 0
      ? provider.incidents[0].name.length > 50 
        ? provider.incidents[0].name.substring(0, 47) + '...' 
        : provider.incidents[0].name
      : '';
    
    return `
      <div class="item item--emphasis-${emphasisLevel}">
        <div class="meta">
          <span class="index">${getStatusIcon(provider.status)}</span>
        </div>
        <div class="content">
          <span class="title title--small">${provider.name}</span>
          <span class="description">${provider.description}</span>
          ${incidentText ? `<span class="label label--small label--underline" data-clamp="1">${incidentText}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  const updatedAt = new Date(data.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="https://usetrmnl.com/css/latest/plugins.css">
  <style>
    /* Fallback styles in case external CSS doesn't load */
    .screen {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: white;
      color: black;
      width: 800px;
      height: 480px;
      padding: 16px;
      box-sizing: border-box;
      position: relative;
    }
    .view--full {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    .layout--col {
      display: flex;
      flex-direction: column;
      flex: 1;
    }
    .gap--large {
      gap: 16px;
    }
    .item {
      display: flex;
      align-items: flex-start;
      border: 1px solid #000;
      border-radius: 4px;
      overflow: hidden;
    }
    .item .meta {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      min-height: 80px;
      background: #f0f0f0;
      border-right: 1px solid #000;
    }
    .item--emphasis-2 .meta {
      background: #c0c0c0;
    }
    .item--emphasis-3 .meta {
      background: #808080;
    }
    .item .index {
      font-size: 24px;
    }
    .item .content {
      flex: 1;
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .title {
      font-weight: 600;
      font-size: 20px;
    }
    .title--small {
      font-size: 18px;
    }
    .description {
      font-size: 14px;
      color: #333;
    }
    .label {
      font-size: 12px;
      display: inline-block;
    }
    .label--underline {
      text-decoration: underline;
    }
    .title_bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-top: 12px;
      margin-top: auto;
      border-top: 1px solid #ccc;
    }
    .title_bar .title {
      font-size: 14px;
      font-weight: 600;
    }
    .title_bar .instance {
      font-size: 12px;
      color: #666;
      margin-left: auto;
    }
  </style>
</head>
<body>
  <div class="screen">
    <div class="view view--full">
      <div class="layout layout--col gap--large">
        ${providersHtml}
      </div>
      <div class="title_bar">
        <span class="title">CDN Status</span>
        <span class="instance">${updatedAt}</span>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ============================================================================
// Preview Template (for browser testing)
// ============================================================================

function renderPreview(data) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>CDN Status - TRMNL Preview</title>
  <style>
    body {
      background: #1a1a1a;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      font-family: sans-serif;
    }
    .frame {
      background: #2a2a2a;
      padding: 20px;
      border-radius: 16px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    }
    .label {
      color: #666;
      text-align: center;
      margin-bottom: 12px;
      font-size: 12px;
    }
    .eink-container {
      border-radius: 4px;
      overflow: hidden;
      /* Simulate e-ink appearance */
      filter: grayscale(100%) contrast(1.1);
    }
    iframe {
      border: none;
      width: 800px;
      height: 480px;
    }
  </style>
</head>
<body>
  <div class="frame">
    <div class="label">TRMNL E-Ink Preview (800×480)</div>
    <div class="eink-container">
      <iframe srcdoc="${renderTrmnlPlugin(data).replace(/"/g, '&quot;')}"></iframe>
    </div>
  </div>
</body>
</html>`;
}

// ============================================================================
// Request Handler
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Health check
    if (path === '/') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'cdn-status-trmnl',
        endpoints: ['/trmnl/plugin', '/api/status', '/preview']
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // JSON API endpoint
    if (path === '/api/status') {
      const skipCache = url.searchParams.has('nocache') || url.searchParams.has('fresh');
      
      if (skipCache) {
        // Bypass cache, fetch fresh data
        const data = await fetchAllStatuses();
        return new Response(JSON.stringify({ ...data, cached: false }, null, 2), {
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache'
          }
        });
      }
      
      const cacheKey = new Request(url.origin + '/cache/status', request);
      const { data, fromCache } = await getCachedStatuses(cacheKey, ctx);
      
      return new Response(JSON.stringify({ ...data, cached: fromCache }, null, 2), {
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`
        }
      });
    }
    
    // Preview endpoint
    if (path === '/preview') {
      const skipCache = url.searchParams.has('nocache') || url.searchParams.has('fresh');
      
      let data;
      if (skipCache) {
        data = await fetchAllStatuses();
      } else {
        const cacheKey = new Request(url.origin + '/cache/status', request);
        ({ data } = await getCachedStatuses(cacheKey, ctx));
      }
      
      return new Response(renderPreview(data), {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    // TRMNL plugin endpoint
    if (path === '/trmnl/plugin') {
      const skipCache = url.searchParams.has('nocache') || url.searchParams.has('fresh');
      
      let data;
      if (skipCache) {
        data = await fetchAllStatuses();
      } else {
        const cacheKey = new Request(url.origin + '/cache/status', request);
        ({ data } = await getCachedStatuses(cacheKey, ctx));
      }
      
      return new Response(renderTrmnlPlugin(data), {
        headers: { 
          'Content-Type': 'text/html',
          'Cache-Control': `public, max-age=${CACHE_TTL}`
        }
      });
    }

    // 404
    return new Response('Not Found', { status: 404 });
  }
};
