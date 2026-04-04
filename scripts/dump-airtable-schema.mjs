/**
 * Dumps the full Airtable base schema using AIRTABLE_API_KEY and AIRTABLE_BASE_ID
 * from the environment. Run with:
 *   AIRTABLE_API_KEY=xxx AIRTABLE_BASE_ID=yyy node scripts/dump-airtable-schema.mjs
 * Or if a .env file is present, it will be loaded automatically.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Load .env if present
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

const apiKey = process.env.AIRTABLE_API_KEY;
const baseId = process.env.AIRTABLE_BASE_ID;

if (!apiKey || !baseId) {
  console.error('ERROR: AIRTABLE_API_KEY and AIRTABLE_BASE_ID must be set in environment or .env file');
  process.exit(1);
}

async function fetchSchema() {
  const url = `https://api.airtable.com/v0/meta/bases/${baseId}/tables`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Airtable API error ${res.status}: ${body}`);
    process.exit(1);
  }

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

fetchSchema().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
