// Parser for Atlassian Statuspage `/api/v2/summary.json` (Cloudflare, Akamai).

import { capitalize, compareItems, rank, toMs } from '../util.js';

const INDICATOR_STATUS = { none: 'ok', minor: 'minor', major: 'major', critical: 'major', maintenance: 'maint' };
const IMPACT_SEVERITY = { critical: 'major', major: 'major', minor: 'minor', maintenance: 'maint', none: 'info' };
const CLOSED_INCIDENT = new Set(['resolved', 'postmortem', 'completed']);
const ACTIVE_MAINTENANCE = new Set(['in_progress', 'verifying']);

const COMPONENT_STATUS = {
  major_outage: { severity: 'major', label: 'Major outage' },
  partial_outage: { severity: 'minor', label: 'Partial outage' },
  degraded_performance: { severity: 'minor', label: 'Degraded' },
  under_maintenance: { severity: 'maint', label: 'Maintenance' }
};

/** "Wroclaw, Poland - (WRO)" -> "WRO"; names without a code are kept as-is. */
export function shortComponentName(name = '') {
  const code = name.match(/\(([A-Z0-9]{3,5})\)\s*$/);
  return code ? code[1] : name;
}

function incidentItems(incidents = []) {
  return incidents
    .filter(inc => !CLOSED_INCIDENT.has(inc.status))
    .map(inc => ({
      title: inc.name,
      detail: capitalize(inc.status),
      severity: IMPACT_SEVERITY[inc.impact] ?? 'minor',
      updatedAt: inc.updated_at
    }));
}

function maintenanceItems(maintenances = []) {
  return maintenances
    .filter(m => ACTIVE_MAINTENANCE.has(m.status))
    .map(m => ({ title: m.name, detail: 'Maintenance in progress', severity: 'maint', updatedAt: m.updated_at }));
}

/**
 * One item per non-operational status. Large sets (e.g. Cloudflare PoPs) are
 * summarised as a count plus a list of short names instead of a single city.
 */
function componentItems(components = []) {
  const byStatus = new Map();
  for (const comp of components) {
    if (comp.group || !COMPONENT_STATUS[comp.status]) continue;
    if (!byStatus.has(comp.status)) byStatus.set(comp.status, []);
    byStatus.get(comp.status).push(comp);
  }

  return [...byStatus].map(([status, comps]) => {
    const { severity, label } = COMPONENT_STATUS[status];
    comps.sort((a, b) => toMs(b.updated_at) - toMs(a.updated_at));
    const updatedAt = comps[0].updated_at;
    if (comps.length === 1) return { title: comps[0].name, detail: label, severity, updatedAt };
    return {
      title: `${label} · ${comps.length} components`,
      detail: comps.map(c => shortComponentName(c.name)).join(', '),
      severity,
      updatedAt
    };
  });
}

export function parseStatuspageSummary(data, provider) {
  // Most severe first; on equal severity, named incidents beat component summaries.
  const items = [
    ...incidentItems(data.incidents).map(item => ({ item, order: 0 })),
    ...maintenanceItems(data.scheduled_maintenances).map(item => ({ item, order: 1 })),
    ...componentItems(data.components).map(item => ({ item, order: 1 }))
  ]
    .sort((a, b) => rank(b.item.severity) - rank(a.item.severity) || a.order - b.order || compareItems(a.item, b.item))
    .map(({ item }) => item);

  return {
    name: provider.name,
    url: data.page?.url ?? provider.pageUrl,
    status: INDICATOR_STATUS[data.status?.indicator] ?? 'minor',
    description: data.status?.description ?? 'Unknown',
    items
  };
}
