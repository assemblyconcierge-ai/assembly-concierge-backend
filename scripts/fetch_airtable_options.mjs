import { createRequire } from 'module';
import { readFileSync } from 'fs';

// Load .env manually
const envPath = '/home/ubuntu/ac-backend/.env';
let envVars = {};
try {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    envVars[key] = val;
  }
} catch (e) {
  console.error('Could not read .env:', e.message);
}

const baseId = process.env.AIRTABLE_BASE_ID || envVars.AIRTABLE_BASE_ID;
const apiKey = process.env.AIRTABLE_API_KEY || envVars.AIRTABLE_API_KEY;
const table  = process.env.AIRTABLE_TABLE_JOBS || envVars.AIRTABLE_TABLE_JOBS || 'Backend Intake Sandbox V2';

if (!baseId || !apiKey) {
  console.error('Missing AIRTABLE_BASE_ID or AIRTABLE_API_KEY');
  process.exit(1);
}

console.log('Base ID:', baseId);
console.log('Table:  ', table);
console.log('');

const url = `https://api.airtable.com/v0/meta/bases/${baseId}/tables`;
const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
const data = await resp.json();

if (!resp.ok) {
  console.error('Airtable API error:', JSON.stringify(data));
  process.exit(1);
}

const t = (data.tables || []).find(t => t.name === table);
if (!t) {
  console.error('Table not found:', table);
  console.error('Available tables:', (data.tables || []).map(x => x.name));
  process.exit(1);
}

// Check the specific fields of interest
const fieldsOfInterest = [
  'Job Status (Canonical Lifecycle)',
  'Status',
  'Area Status',
  'Service Type',
];

for (const fieldName of fieldsOfInterest) {
  const f = t.fields.find(f => f.name === fieldName);
  if (!f) {
    console.log(`Field "${fieldName}": NOT FOUND`);
    continue;
  }
  console.log(`\nField: "${fieldName}" (type: ${f.type})`);
  const choices = f.options?.choices || [];
  if (choices.length === 0) {
    console.log('  (no choices / not a select field)');
  } else {
    for (const c of choices) {
      const bytes = Buffer.from(c.name, 'utf8');
      const hexDash = bytes.toString('hex');
      // Highlight any non-ASCII characters
      const hasNonAscii = [...c.name].some(ch => ch.charCodeAt(0) > 127);
      const flag = hasNonAscii ? ' *** NON-ASCII ***' : '';
      console.log(`  "${c.name}"${flag}  [hex: ${hexDash}]`);
    }
  }
}
