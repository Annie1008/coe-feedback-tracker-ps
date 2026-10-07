// One-off importer for SolutionIQ_UAT_Feedback_Sep28.xlsx -> app_data.feedback (same store the
// app itself reads/writes via GET/POST /api/data). Run with:
//   DATABASE_URL=<heroku postgres url> node scripts/import-uat-feedback.js /path/to/SolutionIQ_UAT_Feedback_Sep28.xlsx
const path = require('path');
const XLSX = require('xlsx');
const { createPool } = require('../server/db');

const SOLUTIONIQ_INITIATIVE_ID = '1';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function toIsoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function buildNotes(row) {
  const parts = [];
  if (row.uatId) parts.push(`UAT ID: ${row.uatId}`);
  if (row.type) parts.push(`Type: ${row.type}`);
  if (row.category) parts.push(`Category: ${row.category}`);
  if (row.priority) parts.push(`Priority: ${row.priority}`);
  if (row.status) parts.push(`Status: ${row.status}`);
  if (row.owner) parts.push(`Owner: ${row.owner}`);
  return parts.join(' | ');
}

function readWorkbook(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets['Field Advisor UAT Feedback'];
  if (!sheet) throw new Error('Sheet "Field Advisor UAT Feedback" not found');
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return rows.map(r => ({
    uatId: String(r['ID'] || '').trim(),
    date: toIsoDate(r['Date']),
    reportedBy: String(r['Reported By'] || '').trim(),
    region: String(r['OU/Region'] || '').trim(),
    type: String(r['Type'] || '').trim(),
    dealContext: String(r['Deal Context'] || '').trim(),
    feedback: String(r['Feedback'] || '').trim(),
    category: String(r['Category'] || '').trim(),
    priority: String(r['Priority'] || '').trim(),
    status: String(r['Status'] || '').trim(),
    owner: String(r['Owner'] || '').trim()
  })).filter(r => r.uatId);
}

function toFeedbackEntry(row) {
  return {
    id: generateId(),
    date: row.date,
    providerName: row.reportedBy,
    providerRole: '',
    region: row.region,
    format: 'UAT Feedback (Sep 28)',
    initiativeId: SOLUTIONIQ_INITIATIVE_ID,
    frictionPoints: row.feedback,
    toolsMentioned: '',
    workarounds: '',
    dealImpact: row.dealContext,
    quotes: '',
    notes: buildNotes(row),
    actionItems: [],
    createdAt: new Date().toISOString()
  };
}

async function run({ pool, filePath, dryRun = false }) {
  const rows = readWorkbook(filePath);
  const entries = rows.map(toFeedbackEntry);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query("SELECT payload FROM app_data WHERE id = 'main' FOR UPDATE");
    if (!result.rows[0]) throw new Error('app_data main payload was not found');
    const payload = result.rows[0].payload || {};
    const existingUatIds = new Set(
      (payload.feedback || [])
        .map(f => (f.notes || '').match(/UAT ID: (UAT-\d+)/))
        .filter(Boolean)
        .map(m => m[1])
    );
    const newEntries = entries.filter((e, i) => !existingUatIds.has(rows[i].uatId));
    const skipped = entries.length - newEntries.length;

    const updatedPayload = { ...payload, feedback: [...newEntries, ...(payload.feedback || [])] };

    if (!dryRun) {
      await client.query(
        "UPDATE app_data SET payload = $1, updated_at = NOW() WHERE id = 'main'",
        [JSON.stringify(updatedPayload)]
      );
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    return { total: entries.length, inserted: newEntries.length, skippedAsDuplicate: skipped };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const filePath = process.argv[2] || path.join(process.env.HOME || '', 'Downloads', 'SolutionIQ_UAT_Feedback_Sep28.xlsx');
  const dryRun = process.argv.includes('--dry-run');
  const pool = createPool();
  if (!pool) throw new Error('DATABASE_URL is required (point it at the Heroku Postgres instance)');
  try {
    const report = await run({ pool, filePath, dryRun });
    console.log(JSON.stringify({ dryRun, filePath, ...report }, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}

module.exports = { run, readWorkbook, toFeedbackEntry };
