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

// Priority order for status severity (higher = more severe)
const STATUS_PRIORITY = {
  'major_outage': 4,
  'partial_outage': 3,
  'degraded_performance': 2,
  'under_maintenance': 1,
  'operational': 0
};

// Format timestamp as relative time (e.g., "2h ago", "yesterday", "3d ago")
function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fetchJsonSummaryStatus(source) {
  return fetch(source.url)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      // Get active incidents (non-resolved)
      // Sort by: 1) severity (major > partial > maintenance), 2) most recent
      const activeIncidents = (data.incidents || [])
        .filter(inc => inc.status !== 'resolved' && inc.status !== 'postmortem')
        .sort((a, b) => {
          // First by impact severity
          const impactOrder = { major: 3, minor: 2, none: 1 };
          const impactDiff = (impactOrder[b.impact] || 0) - (impactOrder[a.impact] || 0);
          if (impactDiff !== 0) return impactDiff;
          // Then by most recent update
          return new Date(b.updated_at) - new Date(a.updated_at);
        })
        .slice(0, 1)
        .map(inc => ({ name: inc.name, status: inc.status, updatedAt: inc.updated_at }));
      
      // Check degraded components if no active incidents
      let degradedComponents = [];
      if (activeIncidents.length === 0) {
        const degraded = (data.components || [])
          .filter(comp => comp.status !== 'operational')
          // Sort by severity, then recency
          .sort((a, b) => {
            const priorityDiff = (STATUS_PRIORITY[b.status] || 0) - (STATUS_PRIORITY[a.status] || 0);
            if (priorityDiff !== 0) return priorityDiff;
            return new Date(b.updated_at) - new Date(a.updated_at);
          });
        
        if (degraded.length > 0) {
          const mostSevere = degraded[0];
          let summary = mostSevere.name;
          
          // Add counts if there are more issues
          const totalOther = degraded.length - 1;
          if (totalOther > 0) {
            summary += ` (+${totalOther} more)`;
          }
          
          degradedComponents = [{ 
            name: summary, 
            status: mostSevere.status,
            updatedAt: mostSevere.updated_at
          }];
        }
      }
      
      const allIssues = activeIncidents.length > 0 ? activeIncidents : degradedComponents;
      
      return {
        name: source.name,
        status: data.status.indicator,
        description: data.status.description,
        url: data.page.url,
        incidents: allIssues
      };
    })
    .catch(error => ({
      name: source.name,
      status: 'error',
      description: `Failed to fetch: ${error.message}`,
      url: source.url,
      incidents: []
    }));
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
    // Get most recent incident for display
    const mostRecent = activeIncidents.length > 0 
      ? { name: activeIncidents[0].title, updatedAt: activeIncidents[0].pubDate?.toISOString() }
      : null;
    
    return {
      name: source.name,
      status: status,
      description: statusDescription,
      url: 'https://www.fastlystatus.com',
      incidents: mostRecent ? [mostRecent] : []
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
// TRMNL Webhook
// ============================================================================

const TRMNL_WEBHOOK_BASE_URL = 'https://usetrmnl.com/api/custom_plugins';
const KV_STATUS_KEY = 'last_status';

/**
 * Generate a hash of the status data to detect changes
 * Only considers status and active incidents, not timestamps
 */
function generateStatusHash(data) {
  const relevantData = data.providers.map(p => ({
    name: p.name,
    status: p.status,
    description: p.description,
    incidentCount: p.incidents?.length || 0,
    incidentNames: p.incidents?.map(i => i.name).sort() || []
  }));
  return JSON.stringify(relevantData);
}

/**
 * Check if status has changed compared to stored state
 */
async function hasStatusChanged(env, currentData) {
  try {
    const lastHash = await env.CDN_STATUS_KV.get(KV_STATUS_KEY);
    const currentHash = generateStatusHash(currentData);
    
    if (lastHash !== currentHash) {
      // Store new hash
      await env.CDN_STATUS_KV.put(KV_STATUS_KEY, currentHash);
      return { changed: true, isFirstRun: lastHash === null };
    }
    
    return { changed: false, isFirstRun: false };
  } catch (error) {
    console.error('Error checking status change:', error);
    return { changed: true, isFirstRun: true }; // Assume changed on error
  }
}

/**
 * Send markup to TRMNL via webhook
 */
async function sendToTrmnlWebhook(env, markup) {
  const pluginUuid = env.TRMNL_PLUGIN_UUID;
  
  if (!pluginUuid) {
    console.error('TRMNL_PLUGIN_UUID not configured');
    return { success: false, error: 'Missing plugin UUID' };
  }
  
  const webhookUrl = `${TRMNL_WEBHOOK_BASE_URL}/${pluginUuid}`;
  
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        merge_variables: { markup: markup }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('TRMNL webhook error:', response.status, errorText);
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }
    
    const result = await response.json();
    console.log('TRMNL webhook success:', result);
    return { success: true, result };
  } catch (error) {
    console.error('TRMNL webhook exception:', error);
    return { success: false, error: error.message };
  }
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

/**
 * Generate just the markup content for TRMNL webhook
 * This is the HTML that goes inside the TRMNL framework
 * Note: Markup is minified to stay under 2kb limit
 */
function renderTrmnlMarkup(data) {
  const providersHtml = data.providers.map(provider => {
    const e = getEmphasisLevel(provider.status);
    const icon = getStatusIcon(provider.status);
    const incident = provider.incidents?.[0];
    let incidentHtml = '';
    if (incident?.name) {
      const timeAgo = incident.updatedAt ? ` (${formatRelativeTime(incident.updatedAt)})` : '';
      incidentHtml = `<span class="label label--underline">${incident.name}${timeAgo}</span>`;
    }
    
    return `<div class="item item--emphasis-${e}"><div class="meta"><span class="index">${icon}</span></div><div class="content"><span class="title">${provider.name}</span><span class="description">${provider.description}</span>${incidentHtml}</div></div>`;
  }).join('');

  const updatedAt = new Date(data.timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });

  // Minified markup to stay under 2kb
  return `<div class="layout layout--col gap--medium">${providersHtml}</div><div class="title_bar"><span class="title">CDN Status</span><span class="instance">${updatedAt}</span></div>`;
}

/**
 * Generate full HTML document for preview/testing
 */
function renderTrmnlPlugin(data) {
  const providersHtml = data.providers.map(provider => {
    const emphasisLevel = getEmphasisLevel(provider.status);
    const incident = provider.incidents?.[0];
    let incidentText = '';
    if (incident?.name) {
      const name = incident.name.length > 40 
        ? incident.name.substring(0, 37) + '...' 
        : incident.name;
      const timeAgo = incident.updatedAt ? ` (${formatRelativeTime(incident.updatedAt)})` : '';
      incidentText = name + timeAgo;
    }
    
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
        endpoints: ['/trmnl/plugin', '/api/status', '/preview', '/trigger']
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Manual trigger endpoint (for testing)
    if (path === '/trigger') {
      const data = await fetchAllStatuses();
      const markup = renderTrmnlMarkup(data);
      const result = await sendToTrmnlWebhook(env, markup);
      
      // Also update KV with current hash
      if (env.CDN_STATUS_KV) {
        const hash = generateStatusHash(data);
        await env.CDN_STATUS_KV.put(KV_STATUS_KEY, hash);
      }
      
      return new Response(JSON.stringify({
        triggered: true,
        webhookResult: result,
        data: data
      }, null, 2), {
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
    
    // TRMNL plugin endpoint (returns full HTML for preview/testing)
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
  },

  // ============================================================================
  // Scheduled Handler (Cron)
  // ============================================================================
  
  async scheduled(event, env, ctx) {
    console.log('Cron triggered at:', new Date().toISOString());
    
    try {
      // Fetch current status from all providers
      const data = await fetchAllStatuses();
      
      // Check if status has changed
      const { changed, isFirstRun } = await hasStatusChanged(env, data);
      
      if (changed) {
        console.log(isFirstRun ? 'First run - sending initial status' : 'Status changed - sending update');
        
        // Generate markup and send to TRMNL
        const markup = renderTrmnlMarkup(data);
        const result = await sendToTrmnlWebhook(env, markup);
        
        if (result.success) {
          console.log('Successfully sent update to TRMNL');
        } else {
          console.error('Failed to send update:', result.error);
        }
      } else {
        console.log('No status change detected - skipping webhook');
      }
    } catch (error) {
      console.error('Scheduled handler error:', error);
    }
  }
};
