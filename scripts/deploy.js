import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const LAYOUTS = ['full', 'half_horizontal', 'half_vertical', 'quadrant'];
const API = 'https://trmnl.com/api';

export async function loadSecrets(env = process.env) {
  if (!env.TRMNL_SECRETS_FILE) return;
  const path = env.TRMNL_SECRETS_FILE.replace(/^~\//, `${homedir()}/`);
  const secrets = parseEnv(await readFile(path, 'utf8'));
  // Read only deployment credentials; never execute a shell secrets file.
  for (const key of ['TRMNL_API_KEY', 'TRMNL_PLUGIN_SETTING_ID']) {
    if (!env[key] && secrets[key]) env[key] = secrets[key];
  }
}

export function readConfig(env) {
  if (!env.TRMNL_API_KEY?.trim() || !env.TRMNL_PLUGIN_SETTING_ID?.trim()) {
    throw new Error('Set TRMNL_API_KEY and TRMNL_PLUGIN_SETTING_ID in .env.local or the environment. See README.md.');
  }
  if (!env.TRMNL_WORKER_URL?.trim()) {
    throw new Error('Set TRMNL_WORKER_URL to your deployed worker URL in .env.local or the environment.');
  }
  const workerUrl = new URL(env.TRMNL_WORKER_URL.trim());
  if (workerUrl.protocol !== 'https:' || workerUrl.username || workerUrl.password || workerUrl.search || workerUrl.hash) {
    throw new Error('TRMNL_WORKER_URL must be an HTTPS URL without credentials, query parameters or a fragment.');
  }
  return {
    apiKey: env.TRMNL_API_KEY.trim(),
    pluginId: env.TRMNL_PLUGIN_SETTING_ID.trim(),
    workerUrl: workerUrl.href.replace(/\/$/, '')
  };
}

export function createClient(config, fetchImpl = fetch) {
  const base = `${API}/plugin_settings/${encodeURIComponent(config.pluginId)}`;
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000)
    });
    // Do not print response bodies: they can contain private plugin data.
    if (!response.ok) {
      const hint = response.status === 401 ? ' Check TRMNL_API_KEY.'
        : response.status === 403 ? ' The key needs Read and Content access to this plugin.'
        : response.status === 404 ? ' Check TRMNL_PLUGIN_SETTING_ID and key access.' : '';
      throw new Error(`TRMNL ${method} ${path} failed (HTTP ${response.status}).${hint}`);
    }
    const result = await response.json();
    if (result.error) throw new Error(`TRMNL ${method} ${path} reported an error.`);
    return result;
  };
}

export async function readMarkup(client) {
  const backup = {};
  for (const layout of LAYOUTS) {
    const result = await client(`/markup/markup_${layout}`);
    if (!result.data || !(typeof result.data.markup === 'string' || result.data.markup === null)) {
      throw new Error(`Unexpected TRMNL markup response for ${layout}.`);
    }
    backup[layout] = result.data.markup;
  }
  return backup;
}

export async function publish({ client, templates, config, fetchImpl = fetch, log = console.log }) {
  // Read the new worker's payload before changing any markup.
  const response = await fetchImpl(`${config.workerUrl}/api/payload`, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`Worker payload request failed (HTTP ${response.status}).`);
  const payload = await response.json();
  if (!Array.isArray(payload.merge_variables?.providers) || !Number.isFinite(payload.bytes)
      || !Number.isFinite(payload.limit) || payload.bytes > payload.limit) {
    throw new Error('Worker returned an invalid or oversized payload.');
  }

  for (const layout of LAYOUTS) {
    const path = `/markup/markup_${layout}`;
    const result = await client(path, { method: 'PUT', body: { content: templates[layout] } });
    if (result.data?.success !== true) throw new Error(`TRMNL did not confirm the ${layout} upload.`);
    const saved = await client(path);
    if (saved.data?.markup !== templates[layout]) throw new Error(`Markup verification failed for ${layout}.`);
    log(`Published and verified ${layout}.`);
  }
  await client('/data', { method: 'POST', body: { merge_variables: payload.merge_variables } });
  const refresh = await client('/refreshes', { method: 'POST' });
  if (!['pending', 'queued'].includes(refresh.data?.status)) throw new Error('TRMNL did not confirm the refresh request.');
  log('Fresh data accepted; screen render requested. Devices will update on their next refresh.');
}

function deployWorker() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolveWrangler(), 'deploy'], { cwd: ROOT, stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Worker deployment failed (exit ${code}).`)));
  });
}

function resolveWrangler() {
  return resolve(ROOT, 'node_modules/wrangler/bin/wrangler.js');
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--worker', '--dry-run'].includes(arg))) throw new Error('Usage: node scripts/deploy.js [--worker] [--dry-run]');
  try { process.loadEnvFile(resolve(ROOT, '.env.local')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await loadSecrets();
  const templates = {};
  for (const layout of LAYOUTS) {
    templates[layout] = await readFile(resolve(ROOT, `templates/${layout}.liquid`), 'utf8');
    if (!templates[layout].trim()) throw new Error(`Template ${layout} is empty.`);
  }
  if (args.includes('--dry-run')) {
    console.log(`Validated ${LAYOUTS.length} local templates. Would ${args.includes('--worker') ? 'deploy the worker, then ' : ''}upload templates, send data and request a render. No network requests made.`);
    return;
  }
  const config = readConfig(process.env);
  const client = createClient(config);
  const markup = await readMarkup(client); // Fail on missing read access before deployment.
  const backupDir = resolve(ROOT, '.wrangler/trmnl-backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = resolve(backupDir, `${Date.now()}.json`);
  await writeFile(backupPath, JSON.stringify({ pluginId: config.pluginId, markup }, null, 2), { mode: 0o600 });
  console.log(`Existing markup backed up to ${backupPath}.`);
  if (args.includes('--worker')) await deployWorker();
  await publish({ client, templates, config });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Deployment stopped: ${error.message}`);
    console.error('Earlier successful steps may already be live. Fix the error and rerun; markup backups are in .wrangler/trmnl-backups/.');
    process.exitCode = 1;
  });
}
