// TRMNL webhook delivery and change/heartbeat decision.

import { buildPayload, payloadBytes, readConfig, statusHash } from './payload.js';

const WEBHOOK_BASE_URL = 'https://usetrmnl.com/api/custom_plugins';
export const STATE_KEY = 'state:v2';

export async function sendToTrmnl(pluginUuid, mergeVariables) {
  if (!pluginUuid) return { ok: false, error: 'TRMNL_PLUGIN_UUID not configured' };

  try {
    const response = await fetch(`${WEBHOOK_BASE_URL}/${encodeURIComponent(pluginUuid)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_variables: mergeVariables }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}: ${await response.text()}` };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function readState(kv) {
  try {
    return await kv.get(STATE_KEY, 'json');
  } catch (error) {
    console.error('KV read failed:', error);
    return null;
  }
}

/**
 * Pushes when the displayed status changed, when the heartbeat is due, or when forced.
 * State is saved only after TRMNL accepts the push, so failed pushes retry on the next run.
 */
export async function pushIfNeeded(env, snapshot, { now = Date.now(), force = false } = {}) {
  const config = readConfig(env);
  const vars = buildPayload(snapshot, config);
  const hash = await statusHash(vars);
  const state = await readState(env.CDN_STATUS_KV);

  const changed = state?.hash !== hash;
  const heartbeatDue = !state || now - state.pushedAt >= config.heartbeatMs;
  const reason = force ? 'forced' : changed ? 'changed' : heartbeatDue ? 'heartbeat' : null;
  if (!reason) return { pushed: false, reason: 'unchanged' };

  const result = await sendToTrmnl(env.TRMNL_PLUGIN_UUID, vars);
  if (!result.ok) return { pushed: false, reason, error: result.error };

  await env.CDN_STATUS_KV.put(STATE_KEY, JSON.stringify({ hash, pushedAt: now }));
  return { pushed: true, reason, bytes: payloadBytes(vars) };
}
