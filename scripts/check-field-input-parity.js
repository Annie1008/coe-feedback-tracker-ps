const crypto = require('node:crypto');
const { createPool } = require('../server/db');
const { listFieldInputs } = require('../server/canonicalApi');
const { buildLegacyImportPlan } = require('../server/legacyImport');

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// canonicalText is intentionally excluded: shared canonical wording and merge winners are not legacy-owned mutable fields.
const FIELDS = ['id','initiativeId','providerName','providerRole','region','date','createdAt','originalText','format','frictionPoints','toolsMentioned','workarounds','dealImpact','quotes','notes'];
function normalizedFeedback(row) {
  const result = Object.fromEntries(FIELDS.map(field => [field, row?.[field] ?? (field === 'initiativeId' || field === 'createdAt' ? null : '')]));
  result.actionItems = (row?.actionItems || []).map(item => ({ id: String(item.id), text: item.text || '', done: Boolean(item.done), createdAt: item.createdAt || null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
function normalizedLoop(value) {
  if (!value) return null;
  return { howIncorporated:value.howIncorporated||'', communicatedBack:value.communicatedBack ?? false,
    communicationMethod:value.communicationMethod||'', closedDate:value.closedDate||null, closed:Boolean(value.closed), notes:value.notes||'' };
}
function compareProjectedData(legacy = {}, canonical = {}) {
  const report = { mismatches: [], missingIds: [], extraIds: [], duplicateLegacyIds: [], duplicateCanonicalIds: [], relationshipErrors: [], initiativeMismatches: [], extraInitiativeIds: [] };
  const index = (rows, duplicates) => { const map = new Map(); for (const row of rows || []) { const id=String(row.id); if(map.has(id)) duplicates.push(id); else map.set(id,row); } return map; };
  const left=index(legacy.feedback,report.duplicateLegacyIds);
  // Projections created before this metadata was added are imported by definition; explicit null marks native rows.
  // Older projections omit the marker; explicit null identifies native canonical rows.
  const imported = (canonical.feedback || []).filter(row => row.legacyFeedbackId !== null);
  const right=index(imported,report.duplicateCanonicalIds);
  for (const row of right.values()) if (row.relationshipError) report.relationshipErrors.push({ id: String(row.id), error: row.relationshipError });
  for (const id of left.keys()) if (!right.has(id)) report.missingIds.push(id);
  for (const id of right.keys()) if (!left.has(id)) report.extraIds.push(id);
  for (const id of left.keys()) if (right.has(id)) {
    const expected = { feedback: normalizedFeedback(left.get(id)), closedLoop: normalizedLoop(legacy.closedLoop?.[id]) };
    const actual = { feedback: normalizedFeedback(right.get(id)), closedLoop: normalizedLoop(canonical.closedLoop?.[id]) };
    if (hash(expected) !== hash(actual)) report.mismatches.push({ id, expectedHash:hash(expected), actualHash:hash(actual), expected, actual });
  }
  const normalizeInitiative = row => ({ id:String(row.id),name:row.name||'',description:row.description||'',rolloutDate:row.rolloutDate||null,color:row.color||null,ouEnablement:row.ouEnablement||{} });
  const expectedInitiatives = new Map((legacy.initiatives || []).map(row => [String(row.id), normalizeInitiative(row)]));
  const actualInitiatives = new Map((canonical.initiatives || []).map(row => [String(row.id), normalizeInitiative(row)]));
  for (const [id, expected] of expectedInitiatives) {
    const actual = actualInitiatives.get(id);
    if (!actual || hash(expected) !== hash(actual)) report.initiativeMismatches.push({ id, expected, actual: actual || null });
  }
  for (const row of canonical.initiatives || []) if (row.legacyImported && !expectedInitiatives.has(String(row.id))) report.extraInitiativeIds.push(String(row.id));
  // Canonically-created initiatives are outside legacy parity and must survive initial reconciliation.
  report.ok = ['mismatches','missingIds','extraIds','duplicateLegacyIds','duplicateCanonicalIds','relationshipErrors','initiativeMismatches','extraInitiativeIds'].every(key => report[key].length === 0);
  report.legacyCount=(legacy.feedback||[]).length; report.canonicalCount=(canonical.feedback||[]).length;
  return report;
}
function expectedLegacyProjection(payload) {
  const plan = buildLegacyImportPlan(payload, { snapshotId: 'parity' });
  const canonicalById = new Map(plan.canonicalFeedback.map(row => [row.id, row]));
  const actionsBySubmission = new Map();
  for (const item of plan.actions) {
    const values = actionsBySubmission.get(item.feedbackSubmissionId) || [];
    values.push({ id:item.id, text:item.text, done:item.done, createdAt:item.createdAt||null });
    actionsBySubmission.set(item.feedbackSubmissionId, values);
  }
  const feedback = plan.submissions.map(row => ({
    ...row.submissionAttributes, id:row.legacyFeedbackId, initiativeId:row.initiativeId,
    providerName:row.providerSnapshot.name, providerRole:row.providerSnapshot.role, region:row.providerSnapshot.region,
    date:row.submittedOn, createdAt:row.sourceCreatedAt, originalText:row.originalText,
    canonicalText:canonicalById.get(row.canonicalFeedbackId)?.canonicalText || '', actionItems:actionsBySubmission.get(row.id)||[]
  }));
  const closedLoop = Object.fromEntries(plan.closedLoops.map(row => [String(row.canonicalFeedbackId), {
    howIncorporated:row.howIncorporated, communicatedBack:row.communicatedBack,
    communicationMethod:row.communicationMethod, closedDate:row.closedDate, closed:row.closed, notes:row.notes
  }]));
  return { feedback, closedLoop };
}
async function checkParity({ pool, client, payload } = {}) {
  const db = client || pool;
  if (!db) throw new Error('DATABASE_URL is required');
  if (!payload) payload = (await db.query("SELECT payload FROM app_data WHERE id='main'")).rows[0]?.payload || {};
  const legacy = expectedLegacyProjection(payload);
  const projected = await listFieldInputs(db, { importedOnly: true, validateRelationships: true });
  const initiatives = await require('../server/canonicalApi').listInitiatives(db);
  return compareProjectedData({ ...legacy, initiatives: payload.initiatives || [] }, { ...projected, initiatives: initiatives.items });
}
async function main() { const pool = createPool(); try { const report = await checkParity({ pool }); console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1; } finally { if (pool) await pool.end(); } }
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
module.exports = { checkParity, compareProjectedData, expectedLegacyProjection };
