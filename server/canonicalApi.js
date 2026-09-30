const crypto = require('node:crypto');
const { readCutoverState, CUTOVER_LOCK_ID } = require('./cutoverState');

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SOURCE_DATA_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SOURCE_DATA_FIELDS = ['sourceType', 'sourceName', 'externalId'];
const LOOP_STRING_FIELDS = ['howIncorporated', 'communicationMethod', 'notes'];
const MAX_REVIEW_REASON = 2000;
const MAX_FEEDBACK_TEXT = 20000;
const MAX_GENERATION_ROWS = 5000;
const MAX_GROUP_EDGES = 1000;
const MAX_GROUP_MEMBERS = 100;
const MAX_FIELD_INPUTS = 5000;
const REVIEW_ACTOR = 'review-token';

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new ApiError(413, 'Request body is too large'));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!isObject(value)) throw new ApiError(400, 'Request body must be a non-null object');
        resolve(value);
      } catch (error) {
        reject(error instanceof ApiError ? error : new ApiError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function uuid(value, field) {
  if (value === undefined) return crypto.randomUUID();
  if (typeof value !== 'string' || !UUID.test(value)) throw new ApiError(400, `${field} must be a UUID`);
  return value;
}

function optionalString(value, field, { nullable = false } = {}) {
  if (value === undefined || (nullable && value === null)) return value;
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a string${nullable ? ' or null' : ''}`);
  return value;
}

function boundedString(value, field, max, { required = false } = {}) {
  optionalString(value, field);
  if (required && (!value || !value.trim())) throw new ApiError(400, `${field} is required`);
  if (value !== undefined && value.length > max) throw new ApiError(400, `${field} must be at most ${max} characters`);
  return value?.trim();
}

function nonnegativeVersion(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new ApiError(400, `${field} must be a nonnegative integer`);
  return value;
}

function validDate(value, field) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a valid YYYY-MM-DD date or null`);
  const match = value.match(DATE);
  if (!match) throw new ApiError(400, `${field} must be a valid YYYY-MM-DD date or null`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) throw new ApiError(400, `${field} must be a valid YYYY-MM-DD date or null`);
  return value;
}

function validInstant(value, field) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, `${field} must be a valid ISO instant or null`);
  }
  return value;
}

function dateOnly(value) {
  if (value === null || value === undefined || typeof value === 'string') return value;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return value;
  const pad = part => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function provider(value) {
  if (!isObject(value)) throw new ApiError(400, 'provider must be an object');
  if (typeof value.name !== 'string' || !value.name.trim()) throw new ApiError(400, 'provider.name is required');
  optionalString(value.role, 'provider.role');
  optionalString(value.region, 'provider.region');
  const result = { name: value.name.trim() };
  if (value.role !== undefined) result.role = value.role;
  if (value.region !== undefined) result.region = value.region;
  return result;
}

function sourceData(value = {}) {
  if (!isObject(value)) throw new ApiError(400, 'sourceData must be an object');
  for (const key of Object.keys(value)) {
    if (!SOURCE_DATA_FIELDS.includes(key)) throw new ApiError(400, `sourceData.${key} is not allowed`);
    optionalString(value[key], `sourceData.${key}`);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SOURCE_DATA_BYTES) throw new ApiError(400, 'sourceData is too large');
  return Object.fromEntries(SOURCE_DATA_FIELDS.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

function publicSourceData(value) {
  if (!isObject(value)) return {};
  return Object.fromEntries(SOURCE_DATA_FIELDS.filter(key => typeof value[key] === 'string').map(key => [key, value[key]]));
}

function idempotencyKey(req) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
    throw new ApiError(400, 'Idempotency-Key must be 16-128 characters using A-Z, a-z, 0-9, dot, underscore, colon, or hyphen');
  }
  return key;
}

function canonical(row) {
  const value = {
    id: row.id,
    title: row.title,
    text: row.canonical_text,
    version: row.version,
    initiative: row.initiative_id ? { id: row.initiative_id, name: row.initiative_name } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closed: Boolean(row.closed)
  };
  if (row.status_updated_at !== undefined) value.statusUpdatedAt = row.status_updated_at;
  return value;
}

function loop(row) {
  if (!row.closed_loop_id) return null;
  return {
    id: row.closed_loop_id,
    howIncorporated: row.how_incorporated,
    communicatedBack: row.communicated_back,
    communicationMethod: row.communication_method,
    closedDate: dateOnly(row.closed_date),
    closed: Boolean(row.closed),
    notes: row.notes,
    version: row.closed_loop_version
  };
}

function action(row) {
  return { id: row.id, text: row.text, done: Boolean(row.done), version: row.version, createdAt: row.created_at };
}

function initiative(row) {
  return { id: row.id, name: row.name, description: row.description, rolloutDate: dateOnly(row.rollout_date), color: row.color,
    ouEnablement: isObject(row.ou_enablement) ? row.ou_enablement : {}, version: row.version,
    legacyImported: Boolean(row.legacy_imported) };
}

function initiativeBody(body, editing = false) {
  const value = {};
  if (!editing || body.name !== undefined) value.name = boundedString(body.name, 'name', 500, { required: true });
  if (body.description !== undefined) value.description = boundedString(body.description, 'description', 5000);
  if (body.rolloutDate !== undefined) value.rolloutDate = validDate(body.rolloutDate || null, 'rolloutDate');
  if (body.color !== undefined) value.color = boundedString(body.color, 'color', 100);
  if (body.ouEnablement !== undefined) {
    if (!isObject(body.ouEnablement)) throw new ApiError(400, 'ouEnablement must be an object');
    value.ouEnablement = body.ouEnablement;
  }
  return value;
}

async function replaceInitiativeEnablement(client, initiativeId, value) {
  await client.query('DELETE FROM initiative_enablement WHERE initiative_id=$1', [initiativeId]);
  let ordinal = 0;
  for (const [ouKey, details] of Object.entries(value || {})) {
    if (!isObject(details)) throw new ApiError(400, `ouEnablement.${ouKey} must be an object`);
    await client.query(`INSERT INTO initiative_enablement
      (id,initiative_id,ou_key,original_ordinal,format,enabled_on,details)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [`initiative:${initiativeId}:${ouKey}`,initiativeId,ouKey,ordinal++,String(details.format||''),details.date||null,{...details,region:ouKey}]);
  }
}

async function createInitiative(pool, req) {
  const body = await parseBody(req); const input = initiativeBody(body); const client = await pool.connect();
  try { await beginWrite(client); const result = await client.query(`INSERT INTO initiatives (id,name,description,rollout_date,color,legacy_imported)
    VALUES ($1,$2,$3,$4::DATE,$5,FALSE) RETURNING id,name,description,rollout_date,color,version`,
  [body.id ? optionalString(body.id, 'id') : crypto.randomUUID(), input.name, input.description || '', input.rolloutDate || null, input.color || null]);
  if (input.ouEnablement !== undefined) await replaceInitiativeEnablement(client, result.rows[0].id, input.ouEnablement);
  await client.query('COMMIT'); return initiative({ ...result.rows[0], ou_enablement: input.ouEnablement || {} });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function listInitiatives(pool) {
  const result = await pool.query(`SELECT i.id,i.name,i.description,i.rollout_date,i.color,i.version,i.legacy_imported,
    COALESCE(e.ou_enablement,'{}'::JSONB) AS ou_enablement FROM initiatives i LEFT JOIN LATERAL (
      SELECT jsonb_object_agg(ie.ou_key, ie.details - 'region') AS ou_enablement
      FROM initiative_enablement ie WHERE ie.initiative_id=i.id) e ON TRUE ORDER BY i.name,i.id`);
  return { items: result.rows.map(initiative) };
}

async function readInitiativeEnablement(client, initiativeId) {
  const result = await client.query(`SELECT COALESCE(jsonb_object_agg(ou_key, details - 'region'),'{}'::JSONB) AS ou_enablement
    FROM initiative_enablement WHERE initiative_id=$1`, [initiativeId]);
  return result.rows[0]?.ou_enablement || {};
}

async function updateInitiative(pool, id, req) {
  const body = await parseBody(req); nonnegativeVersion(body.expectedVersion, 'expectedVersion'); const input = initiativeBody(body, true); const client = await pool.connect();
  try { await beginWrite(client); const result = await client.query(`UPDATE initiatives SET name=COALESCE($3,name),description=COALESCE($4,description),
    rollout_date=CASE WHEN $5::BOOLEAN THEN $6::DATE ELSE rollout_date END,color=COALESCE($7,color),version=version+1,updated_at=NOW()
    WHERE id=$1 AND version=$2 RETURNING id,name,description,rollout_date,color,version`,
  [id,body.expectedVersion,input.name??null,input.description??null,body.rolloutDate!==undefined,input.rolloutDate??null,input.color??null]);
  if (!result.rows[0]) throw new ApiError(409, 'Initiative version is stale or missing');
  if (input.ouEnablement !== undefined) await replaceInitiativeEnablement(client, id, input.ouEnablement);
  const ouEnablement = input.ouEnablement === undefined ? await readInitiativeEnablement(client, id) : input.ouEnablement;
  await client.query('COMMIT'); return initiative({ ...result.rows[0], ou_enablement: ouEnablement });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

function projectedFieldInput(row) {
  const attributes = isObject(row.submission_attributes) ? row.submission_attributes : {};
  const providerValue = isObject(row.provider_snapshot) ? row.provider_snapshot : {};
  return {
    ...attributes,
    id: row.legacy_feedback_id || row.submission_id,
    submissionId: row.submission_id,
    canonicalFeedbackId: row.canonical_feedback_id,
    version: row.submission_version,
    canonicalVersion: row.canonical_version,
    initiativeId: row.initiative_id,
    providerName: providerValue.name || '', providerRole: providerValue.role || '', region: providerValue.region || '',
    date: dateOnly(row.submitted_on), createdAt: row.legacy_feedback_id ? (row.source_created_at || null) : (row.source_created_at || row.created_at),
    originalText: row.original_text || '', canonicalText: row.canonical_text,
    actionItems: Array.isArray(row.action_items) ? row.action_items : []
  };
}

const FIELD_INPUT_SELECT = `
  SELECT fs.id AS submission_id, fs.legacy_feedback_id, fs.canonical_feedback_id,
    fs.version AS submission_version, cf.version AS canonical_version, fs.initiative_id,
    cf.canonical_text, fs.original_text, fs.provider_snapshot, fs.submitted_on,
    fs.source_created_at, fs.created_at, fs.submission_attributes,
    COALESCE(actions.items, '[]'::JSONB) AS action_items,
    cl.id AS closed_loop_id, cl.how_incorporated, cl.communicated_back, cl.communication_method,
    cl.closed_date, cl.closed, cl.notes AS closed_loop_notes, cl.version AS closed_loop_version
  FROM feedback_submissions fs
  JOIN canonical_feedback cf ON cf.id = fs.canonical_feedback_id AND cf.merged_into_id IS NULL AND cf.retired_at IS NULL
  LEFT JOIN closed_loops cl ON cl.feedback_submission_id = fs.id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id', ai.id, 'text', ai.text, 'done', ai.done,
      'version', ai.version, 'createdAt', CASE WHEN ai.raw_legacy IS NOT NULL AND NOT (ai.raw_legacy ? 'createdAt') THEN NULL ELSE ai.created_at END) ORDER BY ai.created_at, ai.id) AS items
    FROM action_items ai WHERE ai.feedback_submission_id = fs.id
  ) actions ON TRUE`;

function projectFieldInputRows(rows) {
  const feedback = rows.map(projectedFieldInput);
  const closedLoop = {};
  rows.forEach((row, index) => {
    if (row.closed_loop_id) closedLoop[feedback[index].id] = loop({ ...row, notes: row.closed_loop_notes });
  });
  return { feedback, closedLoop };
}

async function listFieldInputs(pool, { importedOnly = false, validateRelationships = false } = {}) {
  const result = await pool.query(`${FIELD_INPUT_SELECT}
    WHERE fs.deleted_at IS NULL ${importedOnly ? 'AND fs.legacy_feedback_id IS NOT NULL' : ''}
    ORDER BY fs.created_at DESC, fs.id DESC LIMIT 5001`);
  if (result.rows.length > MAX_FIELD_INPUTS) throw new ApiError(409, `Field Inputs projection is limited to ${MAX_FIELD_INPUTS} rows`);
  const projected = projectFieldInputRows(result.rows);
  if (importedOnly) projected.feedback.forEach((row, index) => { row.legacyFeedbackId = result.rows[index].legacy_feedback_id; });
  if (validateRelationships) {
    const invalid = await pool.query(`SELECT fs.legacy_feedback_id AS id,
      CASE WHEN cf.id IS NULL THEN 'canonical parent missing'
        WHEN cf.retired_at IS NOT NULL THEN 'submission parent is retired'
        WHEN cf.merged_into_id IS NOT NULL AND winner.id IS NULL THEN 'merge winner missing'
        WHEN fs.initiative_id IS DISTINCT FROM COALESCE(winner.initiative_id,cf.initiative_id) AND NOT EXISTS (
          WITH RECURSIVE alias_chain AS (
            SELECT source.id, COALESCE(alias.canonical_feedback_id,source.merged_into_id) AS next_id,
              0 AS depth, ARRAY[source.id]::TEXT[] AS path
            FROM canonical_feedback source
            LEFT JOIN canonical_feedback_aliases alias ON alias.alias_id=source.id
            WHERE source.id=fs.legacy_feedback_id
            UNION ALL
            SELECT target.id, COALESCE(alias.canonical_feedback_id,target.merged_into_id),
              chain.depth+1, chain.path || target.id
            FROM alias_chain chain
            JOIN canonical_feedback target ON target.id=chain.next_id
            LEFT JOIN canonical_feedback_aliases alias ON alias.alias_id=target.id
            WHERE chain.next_id IS NOT NULL AND chain.depth < 32
              AND NOT target.id=ANY(chain.path)
          )
          SELECT 1 FROM alias_chain chain
          WHERE chain.id=COALESCE(winner.id,cf.id) AND chain.next_id IS NULL AND chain.depth > 0
        ) THEN 'initiative relationship mismatch'
      END AS error
      FROM feedback_submissions fs LEFT JOIN canonical_feedback cf ON cf.id=fs.canonical_feedback_id
      LEFT JOIN canonical_feedback winner ON winner.id=cf.merged_into_id
      WHERE fs.legacy_feedback_id IS NOT NULL AND fs.deleted_at IS NULL AND
        (cf.id IS NULL OR cf.retired_at IS NOT NULL OR (cf.merged_into_id IS NOT NULL AND winner.id IS NULL)
          OR (fs.initiative_id IS DISTINCT FROM COALESCE(winner.initiative_id,cf.initiative_id) AND NOT EXISTS (
            WITH RECURSIVE alias_chain AS (
              SELECT source.id, COALESCE(alias.canonical_feedback_id,source.merged_into_id) AS next_id,
                0 AS depth, ARRAY[source.id]::TEXT[] AS path
              FROM canonical_feedback source
              LEFT JOIN canonical_feedback_aliases alias ON alias.alias_id=source.id
              WHERE source.id=fs.legacy_feedback_id
              UNION ALL
              SELECT target.id, COALESCE(alias.canonical_feedback_id,target.merged_into_id),
                chain.depth+1, chain.path || target.id
              FROM alias_chain chain
              JOIN canonical_feedback target ON target.id=chain.next_id
              LEFT JOIN canonical_feedback_aliases alias ON alias.alias_id=target.id
              WHERE chain.next_id IS NOT NULL AND chain.depth < 32
                AND NOT target.id=ANY(chain.path)
            )
            SELECT 1 FROM alias_chain chain
            WHERE chain.id=COALESCE(winner.id,cf.id) AND chain.next_id IS NULL AND chain.depth > 0
          )))`);
    const errors = new Map(invalid.rows.map(row => [String(row.id), row.error]));
    projected.feedback.forEach(row => { if (errors.has(String(row.id))) row.relationshipError = errors.get(String(row.id)); });
  }
  return projected;
}

async function selectFieldInput(client, submissionId) {
  const result = await client.query(`${FIELD_INPUT_SELECT} WHERE fs.id = $1 AND fs.deleted_at IS NULL`, [submissionId]);
  if (!result.rows[0]) throw new ApiError(404, 'Field Input not found');
  return projectedFieldInput(result.rows[0]);
}

const EDITABLE_ATTRIBUTES = ['format', 'frictionPoints', 'toolsMentioned', 'workarounds', 'dealImpact', 'quotes', 'notes'];
function fieldInputBody(body, editing = false) {
  if (!isObject(body)) throw new ApiError(400, 'Request body must be an object');
  if (editing && (body.initiativeId !== undefined || body.canonicalText !== undefined)) throw new ApiError(400, 'Initiative and canonical text cannot be changed');
  const attributes = {};
  for (const field of EDITABLE_ATTRIBUTES) if (body[field] !== undefined) attributes[field] = optionalString(body[field], field);
  const result = { attributes };
  if (body.providerName !== undefined || !editing) result.providerName = boundedString(body.providerName, 'providerName', 500, { required: !editing });
  if (body.providerRole !== undefined) result.providerRole = optionalString(body.providerRole, 'providerRole');
  if (body.region !== undefined) result.region = optionalString(body.region, 'region');
  if (body.date !== undefined) result.date = validDate(body.date || null, 'date');
  if (!editing) result.initiativeId = body.initiativeId || null;
  return result;
}

function fieldText(body) {
  return EDITABLE_ATTRIBUTES.filter(key => body[key]?.trim()).map(key => body[key].trim()).join('\n') || body.originalText?.trim() || '(No notes provided)';
}

async function createFieldInput(pool, req) {
  const key = idempotencyKey(req); const body = await parseBody(req); const input = fieldInputBody(body);
  const hash = requestHash(body); const client = await pool.connect(); const canonicalId = crypto.randomUUID(); const submissionId = crypto.randomUUID();
  try {
    await beginWrite(client); const replay = await reserveIdempotency(client, 'create-field-input', key, hash);
    if (replay) { await client.query('COMMIT'); return replay; }
    if (input.initiativeId) {
      const found = await client.query('SELECT id FROM initiatives WHERE id = $1 FOR UPDATE', [input.initiativeId]);
      if (!found.rows[0]) throw new ApiError(404, 'Initiative not found');
    }
    const text = fieldText(body);
    await client.query('INSERT INTO canonical_feedback (id, initiative_id, canonical_text) VALUES ($1, $2, $3)', [canonicalId, input.initiativeId, text]);
    await client.query(`INSERT INTO feedback_submissions
      (id, canonical_feedback_id, initiative_id, provider_snapshot, submitted_on, source_created_at, original_text, submission_attributes)
      VALUES ($1,$2,$3,$4,$5::DATE,NOW(),$6,$7)`, [submissionId, canonicalId, input.initiativeId,
      { name: input.providerName, role: input.providerRole || '', region: input.region || '' }, input.date || null, text, input.attributes]);
    for (const item of Array.isArray(body.actionItems) ? body.actionItems : []) {
      await client.query(`INSERT INTO action_items (id,canonical_feedback_id,feedback_submission_id,text,done)
        VALUES ($1,$2,$3,$4,$5)`, [crypto.randomUUID(), canonicalId, submissionId, boundedString(item.text, 'actionItems.text', 5000, { required: true }), Boolean(item.done)]);
    }
    const response = await selectFieldInput(client, submissionId);
    await storeIdempotency(client, 'create-field-input', key, hash, response); await client.query('COMMIT'); return response;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function createFieldInputs(pool, req) {
  const key = idempotencyKey(req); const body = await parseBody(req);
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) throw new ApiError(400, 'items must contain 1-100 Field Inputs');
  const inputs = body.items.map(item => ({ body: item, input: fieldInputBody(item) }));
  const hash = requestHash(body); const client = await pool.connect();
  try {
    await beginWrite(client, '30s'); const replay = await reserveIdempotency(client, 'bulk-create-field-inputs', key, hash);
    if (replay) { await client.query('COMMIT'); return replay; }
    const initiativeIds = [...new Set(inputs.map(item => item.input.initiativeId).filter(Boolean))];
    if (initiativeIds.length) {
      const found = await client.query('SELECT id FROM initiatives WHERE id=ANY($1::TEXT[]) ORDER BY id FOR UPDATE', [initiativeIds]);
      if (found.rows.length !== initiativeIds.length) throw new ApiError(404, 'Initiative not found');
    }
    const submissionIds = [];
    for (const item of inputs) {
      const canonicalId = crypto.randomUUID(); const submissionId = crypto.randomUUID(); const text = fieldText(item.body);
      await client.query('INSERT INTO canonical_feedback (id,initiative_id,canonical_text) VALUES ($1,$2,$3)', [canonicalId,item.input.initiativeId,text]);
      await client.query(`INSERT INTO feedback_submissions
        (id,canonical_feedback_id,initiative_id,provider_snapshot,submitted_on,source_created_at,original_text,submission_attributes)
        VALUES ($1,$2,$3,$4,$5::DATE,NOW(),$6,$7)`, [submissionId,canonicalId,item.input.initiativeId,
        { name:item.input.providerName, role:item.input.providerRole||'', region:item.input.region||'' },item.input.date||null,text,item.input.attributes]);
      for (const actionItem of Array.isArray(item.body.actionItems) ? item.body.actionItems : []) {
        await client.query(`INSERT INTO action_items (id,canonical_feedback_id,feedback_submission_id,text,done)
          VALUES ($1,$2,$3,$4,$5)`, [crypto.randomUUID(), canonicalId, submissionId, boundedString(actionItem.text, 'actionItems.text', 5000, { required: true }), Boolean(actionItem.done)]);
      }
      submissionIds.push(submissionId);
    }
    const projected = await client.query(`${FIELD_INPUT_SELECT} WHERE fs.id = ANY($1::TEXT[]) AND fs.deleted_at IS NULL`, [submissionIds]);
    const byId = new Map(projected.rows.map(row => [row.submission_id, projectedFieldInput(row)]));
    const created = submissionIds.map(id => byId.get(id));
    const response = { items: created }; await storeIdempotency(client, 'bulk-create-field-inputs', key, hash, response); await client.query('COMMIT'); return response;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function editFieldInput(pool, submissionId, req) {
  const body = await parseBody(req); nonnegativeVersion(body.expectedVersion, 'expectedVersion'); const input = fieldInputBody(body, true);
  const client = await pool.connect();
  try {
    await beginWrite(client);
    const changed = await client.query(`UPDATE feedback_submissions SET
      provider_snapshot = provider_snapshot || $3::JSONB, submitted_on = CASE WHEN $4::BOOLEAN THEN $5::DATE ELSE submitted_on END,
      original_text = COALESCE($6, original_text), submission_attributes = submission_attributes || $7::JSONB,
      version = version + 1, updated_at = NOW()
      WHERE id = $1 AND version = $2 AND deleted_at IS NULL RETURNING canonical_feedback_id`,
    [submissionId, body.expectedVersion, { ...(input.providerName !== undefined && { name: input.providerName }), ...(input.providerRole !== undefined && { role: input.providerRole }), ...(input.region !== undefined && { region: input.region }) }, body.date !== undefined, input.date ?? null, body.originalText ?? null, input.attributes]);
    if (!changed.rows[0]) throw new ApiError(409, 'Field Input version is stale or deleted');
    const response = await selectFieldInput(client, submissionId); await client.query('COMMIT'); return response;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function deleteFieldInput(pool, submissionId, req) {
  const body = await parseBody(req); nonnegativeVersion(body.expectedVersion, 'expectedVersion'); const client = await pool.connect();
  try { await beginWrite(client); const result = await client.query(`UPDATE feedback_submissions SET deleted_at = NOW(), version = version + 1, updated_at = NOW()
    WHERE id = $1 AND version = $2 AND deleted_at IS NULL RETURNING id, version, canonical_feedback_id`, [submissionId, body.expectedVersion]);
    if (!result.rows[0]) throw new ApiError(409, 'Field Input version is stale or deleted');
    await client.query(`UPDATE canonical_feedback cf SET retired_at = NOW(), version = version + 1, updated_at = NOW()
      WHERE cf.id = $1 AND cf.merged_into_id IS NULL AND cf.retired_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM feedback_submissions fs WHERE fs.canonical_feedback_id = cf.id AND fs.deleted_at IS NULL)`, [result.rows[0].canonical_feedback_id]);
    await client.query('COMMIT'); return { id: result.rows[0].id, version: result.rows[0].version, deleted: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function createAction(pool, submissionId, req) {
  const key = idempotencyKey(req); const body = await parseBody(req); const textValue = boundedString(body.text, 'text', 5000, { required: true });
  const hash = requestHash(body); const client = await pool.connect();
  try { await beginWrite(client); const operation = `create-action:${submissionId}`; const replay = await reserveIdempotency(client, operation, key, hash);
    if (replay) { await client.query('COMMIT'); return replay; }
    const submission = await client.query(`SELECT fs.id, fs.canonical_feedback_id FROM feedback_submissions fs
      JOIN canonical_feedback cf ON cf.id=fs.canonical_feedback_id
      WHERE fs.id = $1 AND fs.deleted_at IS NULL AND cf.merged_into_id IS NULL AND cf.retired_at IS NULL FOR UPDATE OF fs`, [submissionId]);
    if (!submission.rows[0]) throw new ApiError(404, 'Field Input not found');
    const result = await client.query(`INSERT INTO action_items (id,canonical_feedback_id,feedback_submission_id,text,done,idempotency_key)
      VALUES ($1,$2,$3,$4,FALSE,$5) RETURNING id,text,done,version,created_at`, [crypto.randomUUID(), submission.rows[0].canonical_feedback_id, submissionId, textValue, key]);
    const response = action(result.rows[0]); await storeIdempotency(client, operation, key, hash, response); await client.query('COMMIT'); return response;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function mutateAction(pool, submissionId, actionId, req) {
  const body = await parseBody(req); nonnegativeVersion(body.expectedVersion, 'expectedVersion'); const client = await pool.connect();
  try { await beginWrite(client); let result;
    const parent = await client.query(`SELECT ai.id FROM action_items ai
      JOIN feedback_submissions fs ON fs.id=ai.feedback_submission_id
      JOIN canonical_feedback cf ON cf.id=fs.canonical_feedback_id
      WHERE ai.id=$1 AND fs.id=$2 AND fs.deleted_at IS NULL AND cf.merged_into_id IS NULL AND cf.retired_at IS NULL
      FOR UPDATE OF ai, fs, cf`, [actionId, submissionId]);
    if (!parent.rows[0]) throw new ApiError(404, 'Action or active Field Input not found');
    if (req.method === 'DELETE') result = await client.query('DELETE FROM action_items WHERE id=$1 AND feedback_submission_id=$2 AND version=$3 RETURNING id,version', [actionId, submissionId, body.expectedVersion]);
    else {
      if (body.text !== undefined) boundedString(body.text, 'text', 5000, { required: true });
      if (body.done !== undefined && typeof body.done !== 'boolean') throw new ApiError(400, 'done must be a boolean');
      result = await client.query(`UPDATE action_items SET text=COALESCE($4,text),done=COALESCE($5,done),version=version+1,updated_at=NOW()
        WHERE id=$1 AND feedback_submission_id=$2 AND version=$3 RETURNING id,text,done,version,created_at`, [actionId, submissionId, body.expectedVersion, body.text ?? null, body.done ?? null]);
    }
    if (!result.rows[0]) throw new ApiError(409, 'Action version is stale or missing'); await client.query('COMMIT');
    return req.method === 'DELETE' ? { id: actionId, deleted: true } : action(result.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id })).toString('base64url');
}

function decodeCursor(value) {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!cursor.createdAt || !cursor.id || Number.isNaN(Date.parse(cursor.createdAt))) throw new Error();
    return cursor;
  } catch {
    throw new ApiError(400, 'Invalid cursor');
  }
}

function positiveLimit(value, defaultValue, maximum) {
  if (value !== null && value !== undefined && (!/^\d+$/.test(String(value)) || Number(value) < 1)) throw new ApiError(400, 'limit must be a positive integer');
  return Math.min(Number(value || defaultValue), maximum);
}

function encodeCandidateCursor(row) {
  return Buffer.from(JSON.stringify({ score: row.score, id: row.id })).toString('base64url');
}

function decodeCandidateCursor(value) {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof cursor.id !== 'string' || cursor.id.length === 0 || cursor.score === null || !Number.isFinite(Number(cursor.score))) throw new Error();
    return cursor;
  } catch {
    throw new ApiError(400, 'Invalid cursor');
  }
}

function groupIdentifier(memberIds) {
  return `group:${crypto.createHash('sha256').update([...memberIds].sort().join('\0')).digest('hex')}`;
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, 'Malformed path encoding');
  }
}

async function listFeedback(pool, url) {
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1)) throw new ApiError(400, 'limit must be a positive integer');
  const limit = Math.min(Number(rawLimit || 50), 100);
  const initiativeId = url.searchParams.get('initiativeId');
  const cursor = url.searchParams.get('cursor') ? decodeCursor(url.searchParams.get('cursor')) : null;
  const params = [];
  const where = ['cf.merged_into_id IS NULL', 'cf.retired_at IS NULL'];
  if (initiativeId) { params.push(initiativeId); where.push(`cf.initiative_id = $${params.length}`); }
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    where.push(`(cf.created_at, cf.id) < ($${params.length - 1}::TIMESTAMPTZ, $${params.length})`);
  }
  params.push(limit + 1);
  const result = await pool.query(`
    SELECT cf.id, cf.title, cf.canonical_text, cf.version, cf.initiative_id, i.name AS initiative_name,
      cf.created_at, cf.updated_at, cfs.closed, stats.submission_count,
      GREATEST(cf.updated_at, stats.submission_updated_at, stats.loop_updated_at) AS status_updated_at
    FROM canonical_feedback cf
    LEFT JOIN initiatives i ON i.id = cf.initiative_id
    JOIN canonical_feedback_status cfs ON cfs.canonical_feedback_id = cf.id
    LEFT JOIN LATERAL (
      SELECT COUNT(fs.id)::TEXT AS submission_count, MAX(fs.updated_at) AS submission_updated_at,
        MAX(cl.updated_at) AS loop_updated_at
      FROM feedback_submissions fs
      LEFT JOIN closed_loops cl ON cl.feedback_submission_id = fs.id
       WHERE fs.canonical_feedback_id = cf.id AND fs.deleted_at IS NULL
    ) stats ON TRUE
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY cf.created_at DESC, cf.id DESC
    LIMIT $${params.length}`, params);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  return {
    items: rows.map(row => ({ ...canonical(row), submissionCount: Number(row.submission_count) })),
    nextCursor: hasMore ? encodeCursor(rows.at(-1)) : null
  };
}

async function detailFeedback(pool, id) {
  const resolution = await pool.query(`
    WITH RECURSIVE alias_chain AS (
      SELECT cf.id, COALESCE(a.canonical_feedback_id, cf.merged_into_id) AS next_id,
        0 AS depth, ARRAY[cf.id]::TEXT[] AS path
      FROM canonical_feedback cf
      LEFT JOIN canonical_feedback_aliases a ON a.alias_id = cf.id
      WHERE cf.id = $1
      UNION ALL
      SELECT target.id, COALESCE(a.canonical_feedback_id, target.merged_into_id),
        chain.depth + 1, chain.path || target.id
      FROM alias_chain chain
      JOIN canonical_feedback target ON target.id = chain.next_id
      LEFT JOIN canonical_feedback_aliases a ON a.alias_id = target.id
      WHERE chain.next_id IS NOT NULL AND chain.depth < 32
        AND NOT target.id = ANY(chain.path)
    )
    SELECT chain.id AS resolved_id, CASE WHEN chain.id <> $1 THEN $1 END AS resolved_from
    FROM alias_chain chain
     JOIN canonical_feedback active ON active.id = chain.id AND active.merged_into_id IS NULL AND active.retired_at IS NULL
    WHERE chain.next_id IS NULL
    ORDER BY chain.depth DESC LIMIT 1`, [id]);
  if (!resolution.rows[0]) throw new ApiError(404, 'Feedback not found');
  const resolvedId = resolution.rows[0].resolved_id;
  const result = await pool.query(`
    SELECT cf.id, cf.title, cf.canonical_text, cf.version, cf.initiative_id, i.name AS initiative_name,
      cf.created_at, cf.updated_at, cfs.closed,
      GREATEST(cf.updated_at, stats.submission_updated_at, stats.loop_updated_at) AS status_updated_at
    FROM canonical_feedback cf
    LEFT JOIN initiatives i ON i.id = cf.initiative_id
    JOIN canonical_feedback_status cfs ON cfs.canonical_feedback_id = cf.id
    LEFT JOIN LATERAL (
      SELECT MAX(fs.updated_at) AS submission_updated_at, MAX(cl.updated_at) AS loop_updated_at
      FROM feedback_submissions fs LEFT JOIN closed_loops cl ON cl.feedback_submission_id = fs.id
      WHERE fs.canonical_feedback_id = cf.id AND fs.deleted_at IS NULL
    ) stats ON TRUE
    WHERE cf.id = $1 AND cf.merged_into_id IS NULL AND cf.retired_at IS NULL`, [resolvedId]);
  if (!result.rows[0]) throw new ApiError(404, 'Feedback not found');
  const submissions = await pool.query(`
    SELECT fs.id, fs.original_text, fs.provider_snapshot, fs.source_data, fs.submitted_on, fs.source_created_at, fs.version,
      cl.id AS closed_loop_id, cl.how_incorporated, cl.communicated_back, cl.communication_method,
      cl.closed_date, cl.closed, cl.notes, cl.version AS closed_loop_version
    FROM feedback_submissions fs
    LEFT JOIN closed_loops cl ON cl.feedback_submission_id = fs.id
    WHERE fs.canonical_feedback_id = $1 AND fs.deleted_at IS NULL
    ORDER BY fs.created_at, fs.id`, [resolvedId]);
  const response = {
    ...canonical(result.rows[0]),
    submissions: submissions.rows.map(row => ({
      id: row.id, originalText: row.original_text, provider: row.provider_snapshot, sourceData: publicSourceData(row.source_data),
      submittedOn: dateOnly(row.submitted_on), sourceCreatedAt: row.source_created_at, version: row.version,
      closedLoop: loop(row)
    }))
  };
  if (resolution.rows[0].resolved_from) response.resolvedFrom = resolution.rows[0].resolved_from;
  return response;
}

function requestHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

async function beginWrite(client, statementTimeout = '15s') {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query(`SET LOCAL statement_timeout = '${statementTimeout}'`);
  await client.query('SELECT pg_advisory_xact_lock($1)', [CUTOVER_LOCK_ID]);
  const state = await readCutoverState(client);
  if (state.stage !== 'canonical_active') throw new ApiError(409, 'Canonical cutover maintenance is active');
}

async function reserveIdempotency(client, operation, key, hash) {
  await client.query('DELETE FROM api_idempotency WHERE operation = $1 AND idempotency_key = $2 AND expires_at <= NOW()', [operation, key]);
  const reservation = await client.query(`
    INSERT INTO api_idempotency (operation, idempotency_key, request_hash, response)
    VALUES ($1, $2, $3, 'null'::JSONB)
    ON CONFLICT (operation, idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    RETURNING request_hash, response`, [operation, key, hash]);
  const existing = reservation.rows[0];
  if (existing.request_hash && existing.request_hash !== hash) throw new ApiError(409, 'Idempotency key was used with a different request');
  return existing.response || null;
}

async function storeIdempotency(client, operation, key, hash, response) {
  await client.query('UPDATE api_idempotency SET response = $4 WHERE operation = $1 AND idempotency_key = $2 AND request_hash = $3', [operation, key, hash, response]);
}

function validateSubmission(body) {
  optionalString(body.initiativeId, 'initiativeId');
  return {
    submissionId: uuid(body.submissionId, 'submissionId'),
    initiativeId: body.initiativeId || null,
    provider: provider(body.provider),
    date: validDate(body.date, 'date') ?? null,
    sourceCreatedAt: validInstant(body.sourceCreatedAt, 'sourceCreatedAt') ?? null,
    sourceData: sourceData(body.sourceData),
    originalText: boundedString(body.originalText, 'originalText', MAX_FEEDBACK_TEXT, { required: true }),
    attributes: Object.fromEntries(EDITABLE_ATTRIBUTES.filter(field => body[field] !== undefined).map(field => [field, optionalString(body[field], field)]))
  };
}

async function createFeedback(pool, req) {
  const key = idempotencyKey(req);
  const body = await parseBody(req);
  const submission = validateSubmission(body);
  const canonicalText = boundedString(body.canonicalText, 'canonicalText', MAX_FEEDBACK_TEXT, { required: true });
  optionalString(body.title, 'title', { nullable: true });
  const id = uuid(body.id, 'id');
  const hash = requestHash(body);
  const operation = 'create-feedback';
  const client = await pool.connect();
  try {
    await beginWrite(client);
    const replay = await reserveIdempotency(client, operation, key, hash);
    if (replay) { await client.query('COMMIT'); return replay; }
    if (submission.initiativeId) {
      const initiative = await client.query('SELECT id FROM initiatives WHERE id = $1 FOR UPDATE', [submission.initiativeId]);
      if (!initiative.rows[0]) throw new ApiError(404, 'Initiative not found');
    }
    await client.query('INSERT INTO canonical_feedback (id, initiative_id, title, canonical_text) VALUES ($1, $2, $3, $4)',
      [id, submission.initiativeId, body.title ?? null, canonicalText]);
    await client.query('SELECT id FROM canonical_feedback WHERE id = $1 FOR UPDATE', [id]);
    await client.query(`
      INSERT INTO feedback_submissions
        (id, canonical_feedback_id, initiative_id, provider_snapshot, source_data, submitted_on, source_created_at, original_text, submission_attributes)
      VALUES ($1, $2, $3, $4, $5, $6::DATE, $7::TIMESTAMPTZ, $8, $9)`,
    [submission.submissionId, id, submission.initiativeId, submission.provider, submission.sourceData, submission.date, submission.sourceCreatedAt, submission.originalText, submission.attributes]);
    const response = { id, submissionId: submission.submissionId };
    await storeIdempotency(client, operation, key, hash, response);
    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function attachSubmission(pool, canonicalId, req) {
  const key = idempotencyKey(req);
  const body = await parseBody(req);
  const submission = validateSubmission(body);
  const hash = requestHash(body);
  const operation = `attach-submission:${canonicalId}`;
  const client = await pool.connect();
  try {
    await beginWrite(client);
    const replay = await reserveIdempotency(client, operation, key, hash);
    if (replay) { await client.query('COMMIT'); return replay; }
    const parent = await client.query(`
      WITH RECURSIVE alias_chain AS (
        SELECT requested.id, COALESCE(alias.canonical_feedback_id, requested.merged_into_id) AS next_id,
          0 AS depth, ARRAY[requested.id]::TEXT[] AS path
        FROM canonical_feedback requested
        LEFT JOIN canonical_feedback_aliases alias ON alias.alias_id = requested.id
        WHERE requested.id = $1
        UNION ALL
        SELECT target.id, COALESCE(alias.canonical_feedback_id, target.merged_into_id),
          chain.depth + 1, chain.path || target.id
        FROM alias_chain chain
        JOIN canonical_feedback target ON target.id = chain.next_id
        LEFT JOIN canonical_feedback_aliases alias ON alias.alias_id = target.id
        WHERE chain.next_id IS NOT NULL AND chain.depth < 32
          AND NOT target.id = ANY(chain.path)
      )
      SELECT active.id, active.initiative_id
      FROM alias_chain chain
       JOIN canonical_feedback active ON active.id = chain.id AND active.merged_into_id IS NULL AND active.retired_at IS NULL
      WHERE chain.next_id IS NULL
      ORDER BY chain.depth DESC LIMIT 1
      FOR UPDATE OF active`, [canonicalId]);
    if (!parent.rows[0]) throw new ApiError(404, 'Feedback not found');
    const parentInitiativeId = parent.rows[0].initiative_id || null;
    if (body.initiativeId !== undefined && parentInitiativeId !== submission.initiativeId) throw new ApiError(409, 'Submission initiative does not match canonical feedback');
    await client.query(`
      INSERT INTO feedback_submissions
        (id, canonical_feedback_id, initiative_id, provider_snapshot, source_data, submitted_on, source_created_at, original_text, submission_attributes)
      VALUES ($1, $2, $3, $4, $5, $6::DATE, $7::TIMESTAMPTZ, $8, $9)`,
    [submission.submissionId, parent.rows[0].id, parentInitiativeId, submission.provider, submission.sourceData, submission.date, submission.sourceCreatedAt, submission.originalText, submission.attributes]);
    const response = { id: submission.submissionId, canonicalFeedbackId: parent.rows[0].id, canonicalClosed: false };
    await storeIdempotency(client, operation, key, hash, response);
    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function validateCandidateGeneration(body) {
  if (typeof body.initiativeId !== 'string' || !body.initiativeId.trim()) throw new ApiError(400, 'initiativeId is required');
  const threshold = body.threshold === undefined ? 0.45 : body.threshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0.3 || threshold > 1) throw new ApiError(400, 'threshold must be between 0.3 and 1');
  const limitPerItem = body.limitPerItem === undefined ? 10 : body.limitPerItem;
  if (!Number.isInteger(limitPerItem) || limitPerItem < 1 || limitPerItem > 10) throw new ApiError(400, 'limitPerItem must be an integer from 1 to 10');
  return { initiativeId: body.initiativeId.trim(), threshold, limitPerItem };
}

async function generateDuplicateCandidates(pool, req) {
  const key = idempotencyKey(req);
  const body = await parseBody(req);
  const input = validateCandidateGeneration(body);
  const hash = requestHash(body);
  const operation = `generate-duplicate-candidates:${input.initiativeId}`;
  const client = await pool.connect();
  try {
    await beginWrite(client, '30s');
    const replay = await reserveIdempotency(client, operation, key, hash);
    if (replay) { await client.query('COMMIT'); return replay; }
    const initiative = await client.query('SELECT id FROM initiatives WHERE id = $1 FOR UPDATE', [input.initiativeId]);
    if (!initiative.rows[0]) throw new ApiError(404, 'Initiative not found');
    const activeCount = await client.query(`
      SELECT COUNT(*)::TEXT AS active_count FROM canonical_feedback
      WHERE initiative_id = $1 AND merged_into_id IS NULL AND retired_at IS NULL`, [input.initiativeId]);
    if (Number(activeCount.rows[0].active_count) > MAX_GENERATION_ROWS) {
      throw new ApiError(409, `Candidate generation is limited to ${MAX_GENERATION_ROWS} active feedback rows per initiative`);
    }
    await client.query("SELECT set_config('pg_trgm.similarity_threshold', $1, true)", [String(input.threshold)]);
    const generated = await client.query(`
      INSERT INTO duplicate_candidates (id, canonical_feedback_id, candidate_feedback_id, score, evidence)
      WITH eligible AS (
        SELECT * FROM canonical_feedback
        WHERE initiative_id = $1 AND merged_into_id IS NULL AND retired_at IS NULL
          AND normalized_text <> '' AND length(normalized_text) >= 3
      ), pairs AS (
        SELECT left_cf.id AS left_id, right_cf.id AS right_id,
          left_cf.normalized_text AS left_normalized, right_cf.normalized_text AS right_normalized,
          left_cf.canonical_text AS left_text, right_cf.canonical_text AS right_text,
          left_cf.version AS left_version, right_cf.version AS right_version,
          similarity(left_cf.normalized_text, right_cf.normalized_text) AS pair_score
        FROM eligible left_cf JOIN eligible right_cf ON left_cf.id < right_cf.id
        WHERE right_cf.normalized_text % left_cf.normalized_text
      ), endpoint_ranks AS (
        SELECT ranked.*,
          row_number() OVER (PARTITION BY endpoint_id ORDER BY pair_score DESC, peer_id) AS endpoint_rank
        FROM (
          SELECT left_id, right_id, left_id AS endpoint_id, right_id AS peer_id, pair_score FROM pairs
          UNION ALL
          SELECT left_id, right_id, right_id AS endpoint_id, left_id AS peer_id, pair_score FROM pairs
        ) ranked
      ), selected AS (
        SELECT DISTINCT left_id, right_id FROM endpoint_ranks WHERE endpoint_rank <= $2
      )
      SELECT 'duplicate:' || md5(left_cf.id || ':' || right_cf.id), left_cf.id, right_cf.id,
        pairs.pair_score,
        jsonb_build_object(
          'algorithm', 'pg_trgm', 'algorithmVersion', 1,
          'exactNormalized', pairs.left_normalized = pairs.right_normalized,
          'similarity', pairs.pair_score,
          'leftVersion', left_cf.version, 'rightVersion', right_cf.version,
          'leftTextHash', md5(left_cf.canonical_text), 'rightTextHash', md5(right_cf.canonical_text))
      FROM selected
      JOIN pairs USING (left_id, right_id)
      JOIN eligible left_cf ON left_cf.id = selected.left_id
      JOIN eligible right_cf ON right_cf.id = selected.right_id
      ON CONFLICT (pair_low, pair_high) DO UPDATE
        SET score = EXCLUDED.score, evidence = EXCLUDED.evidence,
          version = duplicate_candidates.version + 1, updated_at = NOW()
        WHERE duplicate_candidates.status = 'pending'
          AND (duplicate_candidates.score IS DISTINCT FROM EXCLUDED.score
            OR duplicate_candidates.evidence IS DISTINCT FROM EXCLUDED.evidence)
      RETURNING xmax = 0 AS inserted`, [input.initiativeId, input.limitPerItem]);
    const recovered = await client.query(`
      WITH eligible AS (
        SELECT * FROM canonical_feedback
        WHERE initiative_id = $1 AND merged_into_id IS NULL AND retired_at IS NULL
          AND normalized_text <> '' AND length(normalized_text) >= 3
      ), pairs AS (
        SELECT left_cf.id AS left_id, right_cf.id AS right_id,
          left_cf.version AS left_version, right_cf.version AS right_version,
          left_cf.normalized_text AS left_normalized, right_cf.normalized_text AS right_normalized,
          left_cf.canonical_text AS left_text, right_cf.canonical_text AS right_text,
          similarity(left_cf.normalized_text, right_cf.normalized_text) AS pair_score
        FROM eligible left_cf JOIN eligible right_cf ON left_cf.id < right_cf.id
        WHERE left_cf.initiative_id = $1 AND right_cf.initiative_id = $1
          AND left_cf.merged_into_id IS NULL AND right_cf.merged_into_id IS NULL
          AND left_cf.retired_at IS NULL AND right_cf.retired_at IS NULL
          AND right_cf.normalized_text % left_cf.normalized_text
      ), endpoint_ranks AS (
        SELECT ranked.*, row_number() OVER (PARTITION BY endpoint_id ORDER BY pair_score DESC, peer_id) AS endpoint_rank
        FROM (SELECT left_id,right_id,left_id endpoint_id,right_id peer_id,pair_score FROM pairs
          UNION ALL SELECT left_id,right_id,right_id,left_id,pair_score FROM pairs) ranked
      ), selected AS (SELECT DISTINCT left_id,right_id FROM endpoint_ranks WHERE endpoint_rank <= $2),
      changed AS (
        UPDATE duplicate_candidates dc SET status='pending', score=pairs.pair_score,
          evidence=jsonb_build_object('algorithm','pg_trgm','algorithmVersion',1,'similarity',pairs.pair_score,
            'exactNormalized',pairs.left_normalized=pairs.right_normalized,
            'leftVersion',pairs.left_version,'rightVersion',pairs.right_version,
            'leftTextHash',md5(pairs.left_text),'rightTextHash',md5(pairs.right_text)),
          decided_at=NULL, decided_by=NULL, decision_reason=NULL, merge_operation_id=NULL,
          decision_batch_id=NULL, version=dc.version+1, updated_at=NOW()
        FROM selected JOIN pairs USING (left_id,right_id)
        WHERE dc.pair_low=selected.left_id AND dc.pair_high=selected.right_id
          AND dc.status='superseded' AND dc.decision_reason='canonical feedback merged'
        RETURNING dc.id, dc.version, dc.evidence
      )
      , inserted_events AS (INSERT INTO duplicate_candidate_events
        (id,candidate_id,from_status,to_status,reason_code,evidence_snapshot)
      SELECT 'candidate-event:' || md5(id || ':recovery:' || version::TEXT), id,
        'superseded','pending','system_overlap_recovered',evidence FROM changed
        RETURNING candidate_id)
      SELECT COUNT(*)::TEXT AS recovered FROM inserted_events`,
    [input.initiativeId, input.limitPerItem]);
    const response = {
      generated: generated.rows.filter(row => row.inserted === true).length,
      refreshed: generated.rows.filter(row => row.inserted !== true).length,
      recovered: Number(recovered.rows[0].recovered)
    };
    await storeIdempotency(client, operation, key, hash, response);
    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listDuplicateCandidates(pool, url) {
  const initiativeId = url.searchParams.get('initiativeId');
  if (!initiativeId) throw new ApiError(400, 'initiativeId is required');
  const status = url.searchParams.get('status') || 'pending';
  if (!['pending', 'rejected', 'confirmed', 'superseded'].includes(status)) throw new ApiError(400, 'Invalid status');
  const limit = positiveLimit(url.searchParams.get('limit'), 50, 100);
  const cursor = url.searchParams.get('cursor') ? decodeCandidateCursor(url.searchParams.get('cursor')) : null;
  const params = [initiativeId, status];
  let cursorSql = '';
  if (cursor) { params.push(cursor.score, cursor.id); cursorSql = 'AND (dc.score, dc.id) < ($3::NUMERIC, $4)'; }
  params.push(limit + 1);
  const result = await pool.query(`
    SELECT dc.id,dc.status,dc.score,dc.evidence,dc.version,
      left_cf.id left_id,left_cf.title left_title,left_cf.canonical_text left_text,left_cf.version left_version,
      left_stats.submission_count left_submission_count,left_stats.providers left_providers,
      right_cf.id right_id,right_cf.title right_title,right_cf.canonical_text right_text,right_cf.version right_version,
      right_stats.submission_count right_submission_count,right_stats.providers right_providers
    FROM duplicate_candidates dc
    JOIN canonical_feedback left_cf ON left_cf.id=dc.pair_low AND left_cf.merged_into_id IS NULL AND left_cf.retired_at IS NULL
    JOIN canonical_feedback right_cf ON right_cf.id=dc.pair_high AND right_cf.merged_into_id IS NULL AND right_cf.retired_at IS NULL
    LEFT JOIN LATERAL (SELECT COUNT(*)::TEXT submission_count, COALESCE((SELECT jsonb_agg(name) FROM (SELECT DISTINCT fs.provider_snapshot->>'name' name FROM feedback_submissions fs WHERE fs.canonical_feedback_id=left_cf.id AND fs.deleted_at IS NULL AND fs.provider_snapshot->>'name' IS NOT NULL ORDER BY name LIMIT 20) p),'[]'::JSONB) providers FROM feedback_submissions fs WHERE fs.canonical_feedback_id=left_cf.id AND fs.deleted_at IS NULL) left_stats ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*)::TEXT submission_count, COALESCE((SELECT jsonb_agg(name) FROM (SELECT DISTINCT fs.provider_snapshot->>'name' name FROM feedback_submissions fs WHERE fs.canonical_feedback_id=right_cf.id AND fs.deleted_at IS NULL AND fs.provider_snapshot->>'name' IS NOT NULL ORDER BY name LIMIT 20) p),'[]'::JSONB) providers FROM feedback_submissions fs WHERE fs.canonical_feedback_id=right_cf.id AND fs.deleted_at IS NULL) right_stats ON TRUE
    WHERE left_cf.initiative_id=$1 AND right_cf.initiative_id=$1 AND dc.status=$2 ${cursorSql}
    ORDER BY dc.score DESC NULLS LAST, dc.id DESC LIMIT $${params.length}`, params);
  const hasMore = result.rows.length > limit; const rows = result.rows.slice(0, limit);
  return { items: rows.map(row => ({ id:row.id,status:row.status,score:row.score===null?null:Number(row.score),evidence:row.evidence,version:row.version,
    left:{id:row.left_id,title:row.left_title,text:row.left_text,version:row.left_version,submissionCount:Number(row.left_submission_count),providers:row.left_providers||[]},
    right:{id:row.right_id,title:row.right_title,text:row.right_text,version:row.right_version,submissionCount:Number(row.right_submission_count),providers:row.right_providers||[]} })),
    nextCursor: hasMore ? encodeCandidateCursor(rows.at(-1)) : null };
}

async function listDuplicateGroups(pool, url) {
  const initiativeId = url.searchParams.get('initiativeId');
  if (!initiativeId) throw new ApiError(400, 'initiativeId is required');
  const status = url.searchParams.get('status') || 'pending';
  if (status !== 'pending') throw new ApiError(400, 'Grouped review only lists pending candidates');
  const limit = positiveLimit(url.searchParams.get('limit'), 50, 100);
  const cursor = url.searchParams.get('cursor');
  const offset = cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw new ApiError(400, 'Invalid cursor');
  const result = await pool.query(`
    SELECT dc.id, dc.status, dc.score, dc.evidence, dc.version,
      left_cf.id AS left_id, left_cf.title AS left_title, left_cf.canonical_text AS left_text, left_cf.version AS left_version,
      left_stats.submission_count AS left_submission_count, left_stats.providers AS left_providers,
      right_cf.id AS right_id, right_cf.title AS right_title, right_cf.canonical_text AS right_text, right_cf.version AS right_version,
      right_stats.submission_count AS right_submission_count, right_stats.providers AS right_providers
    FROM duplicate_candidates dc
    JOIN canonical_feedback left_cf ON left_cf.id = dc.pair_low AND left_cf.merged_into_id IS NULL AND left_cf.retired_at IS NULL
    JOIN canonical_feedback right_cf ON right_cf.id = dc.pair_high AND right_cf.merged_into_id IS NULL AND right_cf.retired_at IS NULL
    LEFT JOIN LATERAL (SELECT COUNT(*)::TEXT AS submission_count,
      COALESCE((SELECT jsonb_agg(name) FROM (SELECT DISTINCT fs.provider_snapshot->>'name' AS name FROM feedback_submissions fs WHERE fs.canonical_feedback_id = left_cf.id AND fs.deleted_at IS NULL AND fs.provider_snapshot->>'name' IS NOT NULL ORDER BY name LIMIT 20) p), '[]'::JSONB) AS providers
      FROM feedback_submissions fs WHERE fs.canonical_feedback_id = left_cf.id AND fs.deleted_at IS NULL) left_stats ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*)::TEXT AS submission_count,
      COALESCE((SELECT jsonb_agg(name) FROM (SELECT DISTINCT fs.provider_snapshot->>'name' AS name FROM feedback_submissions fs WHERE fs.canonical_feedback_id = right_cf.id AND fs.deleted_at IS NULL AND fs.provider_snapshot->>'name' IS NOT NULL ORDER BY name LIMIT 20) p), '[]'::JSONB) AS providers
      FROM feedback_submissions fs WHERE fs.canonical_feedback_id = right_cf.id AND fs.deleted_at IS NULL) right_stats ON TRUE
    WHERE left_cf.initiative_id = $1 AND right_cf.initiative_id = $1 AND dc.status = 'pending'
    ORDER BY dc.pair_low, dc.pair_high, dc.id
    LIMIT 1001`, [initiativeId]);
  if (result.rows.length > MAX_GROUP_EDGES) throw new ApiError(409, `Grouped review is limited to ${MAX_GROUP_EDGES} pending edges`);
  const adjacency = new Map();
  const members = new Map();
  const edges = [];
  const member = (row, side) => ({ id: row[`${side}_id`], title: row[`${side}_title`], text: row[`${side}_text`], version: row[`${side}_version`], submissionCount: Number(row[`${side}_submission_count`]), providers: row[`${side}_providers`] || [] });
  for (const row of result.rows) {
    const left = member(row, 'left'); const right = member(row, 'right');
    members.set(left.id, left); members.set(right.id, right);
    if (!adjacency.has(left.id)) adjacency.set(left.id, new Set());
    if (!adjacency.has(right.id)) adjacency.set(right.id, new Set());
    adjacency.get(left.id).add(right.id); adjacency.get(right.id).add(left.id);
    edges.push({ id: row.id, version: row.version, score: Number(row.score), evidence: row.evidence, leftId: left.id, rightId: right.id });
  }
  const groups = []; const seen = new Set();
  for (const start of [...members.keys()].sort()) {
    if (seen.has(start)) continue;
    const ids = []; const queue = [start]; seen.add(start);
    while (queue.length) { const id = queue.shift(); ids.push(id); for (const peer of [...adjacency.get(id)].sort()) if (!seen.has(peer)) { seen.add(peer); queue.push(peer); } }
    ids.sort();
    if (ids.length > MAX_GROUP_MEMBERS) throw new ApiError(409, `A duplicate group is limited to ${MAX_GROUP_MEMBERS} members`);
    const idSet = new Set(ids);
    groups.push({ id: groupIdentifier(ids), members: ids.map(id => members.get(id)), edges: edges.filter(edge => idSet.has(edge.leftId) && idSet.has(edge.rightId)).sort((a, b) => a.id.localeCompare(b.id)) });
  }
  const page = groups.slice(offset, offset + limit);
  return { groups: page, nextCursor: offset + limit < groups.length ? Buffer.from(String(offset + limit)).toString('base64url') : null };
}

async function pendingComponentPreflight(client, candidate) {
  const result = await client.query(`
    WITH RECURSIVE component(id) AS (
      VALUES ($1::TEXT), ($2::TEXT)
      UNION
      SELECT CASE WHEN dc.canonical_feedback_id = component.id THEN dc.candidate_feedback_id ELSE dc.canonical_feedback_id END
      FROM component JOIN duplicate_candidates dc
        ON component.id IN (dc.canonical_feedback_id, dc.candidate_feedback_id)
      JOIN canonical_feedback a ON a.id = dc.canonical_feedback_id AND a.merged_into_id IS NULL AND a.retired_at IS NULL
      JOIN canonical_feedback b ON b.id = dc.candidate_feedback_id AND b.merged_into_id IS NULL AND b.retired_at IS NULL
      WHERE dc.status = 'pending'
    ) SELECT id FROM component LIMIT 3`,
  [candidate.canonical_feedback_id, candidate.candidate_feedback_id]);
  return result.rows.length;
}

function validateGroupConfirm(body) {
  if (typeof body.winnerId !== 'string' || !body.winnerId) throw new ApiError(400, 'winnerId is required');
  if (!Array.isArray(body.members) || body.members.length < 2 || body.members.length > MAX_GROUP_MEMBERS) throw new ApiError(400, 'members must contain 2-100 records');
  if (!Array.isArray(body.edges) || body.edges.length < body.members.length - 1 || body.edges.length > MAX_GROUP_EDGES) throw new ApiError(400, 'edges must contain the connected group edges');
  for (const [name, values] of [['members', body.members], ['edges', body.edges]]) {
    const ids = new Set();
    for (const value of values) {
      if (!isObject(value) || typeof value.id !== 'string' || !value.id) throw new ApiError(400, `${name} IDs are required`);
      nonnegativeVersion(value.expectedVersion, `${name}.expectedVersion`);
      if (ids.has(value.id)) throw new ApiError(400, `${name} must not contain duplicates`);
      ids.add(value.id);
    }
  }
  if (!body.members.some(member => member.id === body.winnerId)) throw new ApiError(400, 'winnerId must be a submitted member');
  if (body.decidedBy !== undefined) throw new ApiError(400, 'decidedBy is not allowed');
  return boundedString(body.reason, 'reason', MAX_REVIEW_REASON, { required: true });
}

async function confirmDuplicateGroup(pool, groupId, req) {
  const key = idempotencyKey(req); const body = await parseBody(req); const reason = validateGroupConfirm(body);
  const hash = requestHash(body); const operation = `confirm-duplicate-group:${groupId}`; const memberIds = body.members.map(member => member.id).sort();
  if (groupId !== groupIdentifier(memberIds)) throw new ApiError(409, 'group ID does not match submitted members');
  const client = await pool.connect();
  try {
    await beginWrite(client, '30s');
    const replay = await reserveIdempotency(client, operation, key, hash); if (replay) { await client.query('COMMIT'); return replay; }
    const initiative = await client.query('SELECT i.id FROM initiatives i JOIN canonical_feedback cf ON cf.initiative_id = i.id WHERE cf.id = $1 FOR UPDATE OF i', [memberIds[0]]);
    if (!initiative.rows[0]) throw new ApiError(404, 'Initiative not found');
    const preflightMembers = await client.query(`
      WITH RECURSIVE component(id) AS (
        VALUES ($1::TEXT) UNION
        SELECT CASE WHEN dc.canonical_feedback_id=component.id THEN dc.candidate_feedback_id ELSE dc.canonical_feedback_id END
        FROM component JOIN duplicate_candidates dc ON component.id IN (dc.canonical_feedback_id,dc.candidate_feedback_id)
        JOIN canonical_feedback a ON a.id=dc.canonical_feedback_id AND a.merged_into_id IS NULL AND a.retired_at IS NULL
        JOIN canonical_feedback b ON b.id=dc.candidate_feedback_id AND b.merged_into_id IS NULL AND b.retired_at IS NULL
        WHERE dc.status='pending'
      ) SELECT id FROM component LIMIT 101`, [memberIds[0]]);
    if (preflightMembers.rows.length > MAX_GROUP_MEMBERS) throw new ApiError(409, `A duplicate group is limited to ${MAX_GROUP_MEMBERS} members`);
    const preflightIds = preflightMembers.rows.map(row => row.id).sort();
    const preflightEdges = await client.query(`SELECT id FROM duplicate_candidates
      WHERE status='pending' AND canonical_feedback_id=ANY($1::TEXT[]) AND candidate_feedback_id=ANY($1::TEXT[])
      ORDER BY id LIMIT 1001`, [preflightIds]);
    if (preflightEdges.rows.length > MAX_GROUP_EDGES) throw new ApiError(409, `Grouped review is limited to ${MAX_GROUP_EDGES} pending edges`);
    const canonicals = await client.query('SELECT id, initiative_id, title, canonical_text, version, merged_into_id FROM canonical_feedback WHERE id = ANY($1::TEXT[]) ORDER BY id FOR UPDATE', [memberIds]);
    if (canonicals.rows.length !== memberIds.length) throw new ApiError(404, 'Canonical feedback not found');
    const expectedMembers = new Map(body.members.map(member => [member.id, member.expectedVersion]));
    if (canonicals.rows.some(row => row.initiative_id !== initiative.rows[0].id || row.merged_into_id || row.version !== expectedMembers.get(row.id))) throw new ApiError(409, 'Canonical feedback is inactive, stale, or belongs to another initiative');
    const component = await client.query(`SELECT id,canonical_feedback_id,candidate_feedback_id,version,score,evidence
      FROM duplicate_candidates WHERE status='pending'
        AND canonical_feedback_id=ANY($1::TEXT[]) AND candidate_feedback_id=ANY($1::TEXT[])
      ORDER BY id FOR UPDATE`, [preflightIds]);
    const actualMemberIds = [...new Set(component.rows.flatMap(edge => [edge.canonical_feedback_id, edge.candidate_feedback_id]))].sort();
    const actualEdgeIds = component.rows.map(edge => edge.id).sort(); const submittedEdgeIds = body.edges.map(edge => edge.id).sort();
    if (JSON.stringify(actualMemberIds) !== JSON.stringify(memberIds) || JSON.stringify(actualEdgeIds) !== JSON.stringify(submittedEdgeIds)) throw new ApiError(409, 'submitted members and edges must equal the exact pending component');
    const expectedEdges = new Map(body.edges.map(edge => [edge.id, edge.expectedVersion])); const canonicalById = new Map(canonicals.rows.map(row => [row.id, row]));
    for (const edge of component.rows) {
      const left = canonicalById.get(edge.canonical_feedback_id); const right = canonicalById.get(edge.candidate_feedback_id);
      if (edge.version !== expectedEdges.get(edge.id) || !edge.evidence || edge.evidence.leftVersion !== left.version || edge.evidence.rightVersion !== right.version) throw new ApiError(409, 'Duplicate group edge evidence or version is stale');
    }
    await client.query('SET CONSTRAINTS closed_loops_submission_canonical_fk, action_items_submission_canonical_fk DEFERRED');
    const loserIds = memberIds.filter(id => id !== body.winnerId); let movedSubmissions = 0; let movedActionItems = 0; let movedClosedLoops = 0;
    const memberCounts = [];
    for (const loserId of loserIds) {
      const submissions = (await client.query('UPDATE feedback_submissions SET canonical_feedback_id = $1, version = version + 1, updated_at = NOW() WHERE canonical_feedback_id = $2', [body.winnerId, loserId])).rowCount;
      const actions = (await client.query('UPDATE action_items SET canonical_feedback_id = $1, version = version + 1, updated_at = NOW() WHERE canonical_feedback_id = $2', [body.winnerId, loserId])).rowCount;
      const loops = (await client.query('UPDATE closed_loops SET canonical_feedback_id = $1, version = version + 1, updated_at = NOW() WHERE canonical_feedback_id = $2', [body.winnerId, loserId])).rowCount;
      movedSubmissions += submissions; movedActionItems += actions; movedClosedLoops += loops;
      memberCounts.push({ loserId, submissions, actions, loops });
      await client.query('UPDATE canonical_feedback SET merged_into_id = $1, merged_at = NOW(), version = version + 1, updated_at = NOW() WHERE id = $2 AND merged_into_id IS NULL', [body.winnerId, loserId]);
    }
    await client.query('UPDATE canonical_feedback SET version = version + 1, updated_at = NOW() WHERE id = $1 AND merged_into_id IS NULL', [body.winnerId]);
    const batchId = crypto.randomUUID(); const snapshot = { members: canonicals.rows, edges: component.rows, counts: { movedSubmissions, movedActionItems, movedClosedLoops } };
    await client.query(`INSERT INTO canonical_merge_batches (id, initiative_id, winner_id, member_ids, evidence_snapshot, reason, actor_label, request_hash, moved_submission_count, moved_action_item_count, moved_closed_loop_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [batchId, initiative.rows[0].id, body.winnerId, JSON.stringify(memberIds), snapshot, reason, REVIEW_ACTOR, hash, movedSubmissions, movedActionItems, movedClosedLoops]);
    const batchMemberIds = [];
    for (const counts of memberCounts) {
      const memberId = crypto.randomUUID(); batchMemberIds.push(memberId);
      const supporting = component.rows.filter(edge => [edge.canonical_feedback_id, edge.candidate_feedback_id].includes(counts.loserId)).map(edge => edge.id).sort();
      await client.query(`INSERT INTO canonical_merge_batch_members
        (id,merge_batch_id,winner_id,loser_id,supporting_candidate_ids,moved_submission_count,moved_action_item_count,moved_closed_loop_count,evidence_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [memberId,batchId,body.winnerId,counts.loserId,JSON.stringify(supporting),counts.submissions,counts.actions,counts.loops,{ supportingCandidateIds:supporting }]);
      await client.query('INSERT INTO canonical_feedback_aliases (alias_id,canonical_feedback_id,merge_batch_member_id) VALUES ($1,$2,$3)', [counts.loserId,body.winnerId,memberId]);
    }
    await client.query("UPDATE duplicate_candidates SET status='confirmed',decided_at=NOW(),decided_by=$2,decision_reason=$3,decision_batch_id=$4,version=version+1,updated_at=NOW() WHERE id=ANY($1::TEXT[]) AND status='pending'", [actualEdgeIds,REVIEW_ACTOR,reason,batchId]);
    await client.query(`INSERT INTO duplicate_candidate_events (id,candidate_id,from_status,to_status,reason_code,evidence_snapshot,merge_batch_id)
      SELECT 'candidate-event:' || md5(id || ':' || $1), id, 'pending', status, CASE WHEN status='confirmed' THEN 'group_merge_support' ELSE 'group_merge_redundant' END, evidence, $1 FROM duplicate_candidates WHERE id=ANY($2::TEXT[])`, [batchId, actualEdgeIds]);
    const external = await client.query("UPDATE duplicate_candidates SET status='superseded', decided_at=NOW(), decision_reason='canonical feedback merged', decision_batch_id=$2, version=version+1, updated_at=NOW() WHERE status='pending' AND (canonical_feedback_id=ANY($1::TEXT[]) OR candidate_feedback_id=ANY($1::TEXT[])) RETURNING id,evidence", [memberIds, batchId]);
    if (external.rows.length) await client.query(`INSERT INTO duplicate_candidate_events (id,candidate_id,from_status,to_status,reason_code,evidence_snapshot,merge_batch_id) SELECT 'candidate-event:' || md5(item.id || ':' || $1), item.id, 'pending','superseded','group_merge_incident',item.evidence,$1 FROM jsonb_to_recordset($2::JSONB) AS item(id TEXT,evidence JSONB)`, [batchId, JSON.stringify(external.rows)]);
    await client.query('UPDATE canonical_summaries SET stale=TRUE, stale_at=NOW(), version=version+1, updated_at=NOW() WHERE canonical_feedback_id=ANY($1::TEXT[])', [memberIds]);
    const response = { mergeBatchId: batchId, winnerId: body.winnerId, memberIds, batchMemberIds, movedSubmissions, movedActionItems, movedClosedLoops };
    await storeIdempotency(client, operation, key, hash, response); await client.query('COMMIT'); return response;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function rejectDuplicateCandidate(pool, candidateId, req) {
  const key = idempotencyKey(req);
  const body = await parseBody(req);
  nonnegativeVersion(body.expectedVersion, 'expectedVersion');
  if (body.decidedBy !== undefined) throw new ApiError(400, 'decidedBy is not allowed');
  const reason = boundedString(body.reason, 'reason', MAX_REVIEW_REASON);
  const hash = requestHash(body);
  const operation = `reject-duplicate-candidate:${candidateId}`;
  const client = await pool.connect();
  try {
    await beginWrite(client);
    const replay = await reserveIdempotency(client, operation, key, hash);
    if (replay) { await client.query('COMMIT'); return replay; }
    const found = await client.query('SELECT id, status, version FROM duplicate_candidates WHERE id = $1 FOR UPDATE', [candidateId]);
    if (!found.rows[0]) throw new ApiError(404, 'Duplicate candidate not found');
    if (found.rows[0].status !== 'pending' || found.rows[0].version !== body.expectedVersion) throw new ApiError(409, 'Duplicate candidate is stale or already decided');
    const changed = await client.query(`
      UPDATE duplicate_candidates SET status = 'rejected', decided_at = NOW(), decided_by = $2,
        decision_reason = $3, version = version + 1, updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND version = $4
      RETURNING id, status, version, decided_at, decided_by, decision_reason`, [candidateId, REVIEW_ACTOR, reason || null, body.expectedVersion]);
    if (!changed.rows[0]) throw new ApiError(409, 'Duplicate candidate is stale or already decided');
    await client.query(`INSERT INTO duplicate_candidate_events
      (id,candidate_id,from_status,to_status,reason_code,evidence_snapshot)
      VALUES ($1,$2,'pending','rejected','review_rejected',$3)`,
    [crypto.randomUUID(), candidateId, { reason: reason || null, expectedVersion: body.expectedVersion }]);
    const row = changed.rows[0];
    const response = { id: row.id, status: row.status, version: row.version, decidedAt: row.decided_at, decidedBy: row.decided_by, reason: row.decision_reason };
    await storeIdempotency(client, operation, key, hash, response);
    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function confirmDuplicateCandidate(pool, candidateId, req) {
  const key = idempotencyKey(req);
  const body = await parseBody(req);
  for (const field of ['winnerId', 'loserId']) if (typeof body[field] !== 'string' || !body[field]) throw new ApiError(400, `${field} is required`);
  if (body.winnerId === body.loserId) throw new ApiError(400, 'winnerId and loserId must differ');
  for (const field of ['expectedVersion', 'expectedWinnerVersion', 'expectedLoserVersion']) nonnegativeVersion(body[field], field);
  if (body.decidedBy !== undefined) throw new ApiError(400, 'decidedBy is not allowed');
  const reason = boundedString(body.reason, 'reason', MAX_REVIEW_REASON, { required: true });
  const hash = requestHash(body);
  const operation = `confirm-duplicate-candidate:${candidateId}`;
  const client = await pool.connect();
  try {
    await beginWrite(client);
    const replay = await reserveIdempotency(client, operation, key, hash);
    if (replay) { await client.query('COMMIT'); return replay; }
    const initiative = await client.query(`SELECT i.id FROM initiatives i
      JOIN canonical_feedback cf ON cf.initiative_id=i.id
      WHERE cf.id=$1 FOR UPDATE OF i`, [body.winnerId]);
    if (!initiative.rows[0]) throw new ApiError(409, 'Canonical feedback is inactive or belongs to another initiative');
    const preflight = await client.query(`
      SELECT id, canonical_feedback_id, candidate_feedback_id, status, version
      FROM duplicate_candidates WHERE id = $1`, [candidateId]);
    const preflightCandidate = preflight.rows[0];
    if (!preflightCandidate) throw new ApiError(404, 'Duplicate candidate not found');
    if (preflightCandidate.status !== 'pending' || preflightCandidate.version !== body.expectedVersion) throw new ApiError(409, 'Duplicate candidate is stale or already decided');
    if (new Set([preflightCandidate.canonical_feedback_id, preflightCandidate.candidate_feedback_id, body.winnerId, body.loserId]).size !== 2) throw new ApiError(409, 'Duplicate candidate pair does not match winner and loser');
    if (await pendingComponentPreflight(client, preflightCandidate) > 2) throw new ApiError(409, 'group review required');
    const canonicals = await client.query(`
      SELECT id, initiative_id, title, canonical_text, version, merged_into_id FROM canonical_feedback
      WHERE id = ANY($1::TEXT[]) ORDER BY id FOR UPDATE`, [[body.winnerId, body.loserId].sort()]);
    if (canonicals.rows.length !== 2) throw new ApiError(404, 'Canonical feedback not found');
    const byId = new Map(canonicals.rows.map(row => [row.id, row]));
    const winner = byId.get(body.winnerId);
    const loser = byId.get(body.loserId);
    if (!winner || !loser) throw new ApiError(404, 'Canonical feedback not found');
    if (winner.merged_into_id || loser.merged_into_id || winner.initiative_id !== loser.initiative_id) throw new ApiError(409, 'Canonical feedback is inactive or belongs to another initiative');
    if (winner.version !== body.expectedWinnerVersion || loser.version !== body.expectedLoserVersion) throw new ApiError(409, 'Canonical feedback version is stale');
    const found = await client.query(`
      SELECT id, canonical_feedback_id, candidate_feedback_id, status, version, score, evidence
      FROM duplicate_candidates WHERE id = $1 FOR UPDATE`, [candidateId]);
    const candidate = found.rows[0];
    if (!candidate) throw new ApiError(404, 'Duplicate candidate not found');
    if (candidate.status !== 'pending' || candidate.version !== body.expectedVersion) throw new ApiError(409, 'Duplicate candidate is stale or already decided');
    if (new Set([candidate.canonical_feedback_id, candidate.candidate_feedback_id, body.winnerId, body.loserId]).size !== 2) throw new ApiError(409, 'Duplicate candidate pair does not match winner and loser');
    const left = byId.get(candidate.canonical_feedback_id);
    const right = byId.get(candidate.candidate_feedback_id);
    if (!candidate.evidence || candidate.evidence.leftVersion !== left.version || candidate.evidence.rightVersion !== right.version) {
      throw new ApiError(409, 'Duplicate candidate evidence is stale');
    }

    await client.query('SET CONSTRAINTS closed_loops_submission_canonical_fk, action_items_submission_canonical_fk DEFERRED');
    const submissions = await client.query('UPDATE feedback_submissions SET canonical_feedback_id = $1, version = version + 1, updated_at = NOW() WHERE canonical_feedback_id = $2', [body.winnerId, body.loserId]);
    const actions = await client.query('UPDATE action_items SET canonical_feedback_id = $1, version = version + 1, updated_at = NOW() WHERE canonical_feedback_id = $2', [body.winnerId, body.loserId]);
    const loops = await client.query('UPDATE closed_loops SET canonical_feedback_id = $1, version = version + 1, updated_at = NOW() WHERE canonical_feedback_id = $2', [body.winnerId, body.loserId]);
    const loserChange = await client.query(`
      UPDATE canonical_feedback SET merged_into_id = $1, merged_at = NOW(), version = version + 1, updated_at = NOW()
      WHERE id = $2 AND version = $3 AND merged_into_id IS NULL`, [body.winnerId, body.loserId, body.expectedLoserVersion]);
    const winnerChange = await client.query('UPDATE canonical_feedback SET version = version + 1, updated_at = NOW() WHERE id = $1 AND version = $2 AND merged_into_id IS NULL', [body.winnerId, body.expectedWinnerVersion]);
    if (loserChange.rowCount !== 1 || winnerChange.rowCount !== 1) throw new ApiError(409, 'Canonical feedback version is stale');
    const operationId = crypto.randomUUID();
    const evidenceSnapshot = {
      candidate: { id: candidate.id, version: candidate.version, score: candidate.score, evidence: candidate.evidence },
      winner: { id: winner.id, title: winner.title, text: winner.canonical_text, version: winner.version },
      loser: { id: loser.id, title: loser.title, text: loser.canonical_text, version: loser.version },
      counts: { movedSubmissions: submissions.rowCount, movedActionItems: actions.rowCount, movedClosedLoops: loops.rowCount }
    };
    const audit = await client.query(`
      INSERT INTO canonical_merge_operations
        (id, candidate_id, winner_id, loser_id, moved_submission_count, moved_action_item_count,
          moved_closed_loop_count, evidence_snapshot, reason, actor_label, request_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id`, [operationId, candidateId, body.winnerId, body.loserId, submissions.rowCount, actions.rowCount, loops.rowCount, evidenceSnapshot, reason, REVIEW_ACTOR, hash]);
    await client.query(`
      INSERT INTO canonical_feedback_aliases (alias_id, canonical_feedback_id, merge_operation_id)
      VALUES ($1, $2, $3)`, [body.loserId, body.winnerId, audit.rows[0].id]);
    await client.query(`
      UPDATE duplicate_candidates SET status = 'confirmed', decided_at = NOW(), decided_by = $2,
        decision_reason = $3, merge_operation_id = $4, version = version + 1, updated_at = NOW()
      WHERE id = $1 AND status = 'pending'`, [candidateId, REVIEW_ACTOR, reason, audit.rows[0].id]);
    await client.query(`WITH changed AS (
      UPDATE duplicate_candidates SET status='superseded',decided_at=NOW(),decision_reason='canonical feedback merged',
        merge_operation_id=$4,version=version+1,updated_at=NOW()
      WHERE id<>$1 AND status='pending'
        AND (canonical_feedback_id IN ($2,$3) OR candidate_feedback_id IN ($2,$3))
      RETURNING id, evidence
    ) INSERT INTO duplicate_candidate_events
      (id,candidate_id,from_status,to_status,reason_code,evidence_snapshot,merge_operation_id)
      SELECT 'candidate-event:' || md5(id || ':' || $4),id,'pending','superseded','merge_incident_superseded',evidence,$4
      FROM changed`, [candidateId,body.winnerId,body.loserId,audit.rows[0].id]);
    await client.query(`INSERT INTO duplicate_candidate_events
      (id,candidate_id,from_status,to_status,reason_code,evidence_snapshot,merge_operation_id)
      VALUES ($1,$2,'pending','confirmed','review_confirmed',$3,$4)`,
    [crypto.randomUUID(), candidateId, evidenceSnapshot, audit.rows[0].id]);
    await client.query('UPDATE canonical_summaries SET stale = TRUE, stale_at = NOW(), version = version + 1, updated_at = NOW() WHERE canonical_feedback_id = ANY($1::TEXT[])', [[body.winnerId, body.loserId]]);
    const closure = await client.query(`
      SELECT EXISTS (SELECT 1 FROM feedback_submissions WHERE canonical_feedback_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM feedback_submissions fs LEFT JOIN closed_loops cl ON cl.feedback_submission_id = fs.id
          WHERE fs.canonical_feedback_id = $1 AND fs.deleted_at IS NULL AND COALESCE(cl.closed, FALSE) = FALSE
        ) AS closed`, [body.winnerId]);
    const response = {
      candidateId, mergeOperationId: audit.rows[0].id, winnerId: body.winnerId, loserId: body.loserId,
      movedSubmissions: submissions.rowCount, movedActionItems: actions.rowCount, movedClosedLoops: loops.rowCount,
      canonicalClosed: Boolean(closure.rows[0].closed)
    };
    await storeIdempotency(client, operation, key, hash, response);
    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function validateLoopPatch(body) {
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) throw new ApiError(400, 'expectedVersion must be a nonnegative integer');
  for (const field of LOOP_STRING_FIELDS) optionalString(body[field], field);
  if (body.communicatedBack !== undefined && typeof body.communicatedBack !== 'boolean' && !['Yes', 'No', 'Pending'].includes(body.communicatedBack)) {
    throw new ApiError(400, 'communicatedBack must be Yes, No, Pending, or a boolean');
  }
  if (body.closed !== undefined && typeof body.closed !== 'boolean') throw new ApiError(400, 'closed must be a boolean');
  validDate(body.closedDate, 'closedDate');
}

function communicatedBack(value) {
  return value === true ? 'Yes' : value === false ? 'No' : value;
}

async function mutateClosedLoop(pool, submissionId, req) {
  const key = idempotencyKey(req);
  const body = await parseBody(req);
  validateLoopPatch(body);
  const hash = requestHash(body);
  const client = await pool.connect();
  try {
    await beginWrite(client);
    const operation = `closed-loop:${submissionId}`;
    const replay = await reserveIdempotency(client, operation, key, hash);
    if (replay) { await client.query('COMMIT'); return replay; }
    const parent = await client.query(`
      SELECT cf.id AS canonical_feedback_id
       FROM canonical_feedback cf
       JOIN feedback_submissions fs ON fs.canonical_feedback_id = cf.id
        WHERE fs.id = $1 AND fs.deleted_at IS NULL AND cf.merged_into_id IS NULL AND cf.retired_at IS NULL
      FOR UPDATE OF cf`, [submissionId]);
    if (!parent.rows[0]) throw new ApiError(404, 'Submission not found');
    const canonicalId = parent.rows[0].canonical_feedback_id;
    const found = await client.query(`
      SELECT fs.id AS submission_id, fs.canonical_feedback_id, cl.id AS loop_id, cl.version AS loop_version,
        cl.how_incorporated, cl.communicated_back, cl.communication_method, cl.closed_date, cl.closed, cl.notes
      FROM feedback_submissions fs LEFT JOIN closed_loops cl ON cl.feedback_submission_id = fs.id
      WHERE fs.id = $1 AND fs.canonical_feedback_id = $2 FOR UPDATE OF fs`, [submissionId, canonicalId]);
    const current = found.rows[0];
    if (!current) throw new ApiError(404, 'Submission not found');
    const version = current.loop_version || 0;
    if (body.expectedVersion !== version) throw new ApiError(409, 'Closed-loop version is stale');
    const values = [
      body.howIncorporated ?? current.how_incorporated ?? '',
      body.communicatedBack === undefined ? (current.communicated_back ?? 'Pending') : communicatedBack(body.communicatedBack),
      body.communicationMethod ?? current.communication_method ?? '',
      body.closedDate === undefined ? (current.closed_date ?? null) : body.closedDate,
      body.closed ?? current.closed ?? false,
      body.notes ?? current.notes ?? ''
    ];
    let changed;
    if (version === 0) {
      changed = await client.query(`
        INSERT INTO closed_loops (id, canonical_feedback_id, feedback_submission_id, how_incorporated,
          communicated_back, communication_method, closed_date, closed, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id AS closed_loop_id, how_incorporated, communicated_back, communication_method,
          closed_date, closed, notes, version AS closed_loop_version`,
      [`loop:${submissionId}`, canonicalId, submissionId, ...values]);
    } else {
      changed = await client.query(`
        UPDATE closed_loops SET how_incorporated = $2, communicated_back = $3, communication_method = $4,
          closed_date = $5, closed = $6, notes = $7, version = version + 1, updated_at = NOW()
        WHERE feedback_submission_id = $1 AND canonical_feedback_id = $8 AND version = $9
        RETURNING id AS closed_loop_id, how_incorporated, communicated_back, communication_method,
          closed_date, closed, notes, version AS closed_loop_version`,
      [submissionId, ...values, canonicalId, body.expectedVersion]);
      if (!changed.rows[0]) throw new ApiError(409, 'Closed-loop version is stale');
    }
    const status = await client.query(`
      SELECT EXISTS (SELECT 1 FROM feedback_submissions WHERE canonical_feedback_id = $1 AND deleted_at IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM feedback_submissions fs LEFT JOIN closed_loops cl ON cl.feedback_submission_id = fs.id
           WHERE fs.canonical_feedback_id = $1 AND fs.deleted_at IS NULL AND COALESCE(cl.closed, FALSE) = FALSE
        ) AS closed`, [canonicalId]);
    const response = { closedLoop: loop(changed.rows[0]), canonicalClosed: Boolean(status.rows[0].closed) };
    await storeIdempotency(client, operation, key, hash, response);
    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// appOrigin may be a single origin or a comma-separated list — see the matching comment on
// validateAppDataWrite in server/appData.js for why.
function isTrustedOrigin(req, appOrigin, production = process.env.NODE_ENV === 'production') {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const normalized = new URL(origin).origin;
    const trustedOrigins = (appOrigin || '').split(',').map(o => o.trim()).filter(Boolean);
    if (trustedOrigins.some(candidate => { try { return normalized === new URL(candidate).origin; } catch { return false; } })) return true;
    return !production && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized);
  } catch {
    return false;
  }
}

function requireMergeReviewToken(req, serverToken) {
  if (typeof serverToken !== 'string' || serverToken.length === 0) throw new ApiError(503, 'Merge review is not configured');
  const supplied = req.headers['x-merge-review-token'];
  if (typeof supplied !== 'string') throw new ApiError(401, 'Unauthorized');
  const expectedDigest = crypto.createHash('sha256').update(serverToken).digest();
  const suppliedDigest = crypto.createHash('sha256').update(supplied).digest();
  if (!crypto.timingSafeEqual(expectedDigest, suppliedDigest)) throw new ApiError(401, 'Unauthorized');
}

function isMergeReviewRoute(pathname) {
  return pathname === '/api/canonical/duplicate-candidates'
    || pathname === '/api/canonical/duplicate-groups'
    || pathname === '/api/canonical/duplicate-candidates/generate'
    || /^\/api\/canonical\/duplicate-candidates\/[^/]+\/(?:reject|confirm)$/.test(pathname)
    || /^\/api\/canonical\/duplicate-groups\/[^/]+\/confirm$/.test(pathname);
}

function isFieldInputsRoute(pathname) {
  return pathname === '/api/canonical/field-inputs'
    || pathname.startsWith('/api/canonical/field-inputs/')
    || /^\/api\/canonical\/submissions\/[^/]+\/closed-loop$/.test(pathname);
}

function isInitiativeRoute(pathname) {
  return pathname === '/api/canonical/initiatives' || /^\/api\/canonical\/initiatives\/[^/]+$/.test(pathname);
}

function isCanonicalMutationRoute(method, pathname) {
  return ['POST', 'PATCH', 'DELETE'].includes(method) && pathname.startsWith('/api/canonical/') && pathname !== '/api/canonical/cutover-state';
}

function createCanonicalApiHandler({ pool, appOrigin = process.env.APP_ORIGIN, mergeReviewToken = process.env.MERGE_REVIEW_TOKEN, production = process.env.NODE_ENV === 'production', env }) {
  return async function canonicalApiHandler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return false;
    }
    if (!url.pathname.startsWith('/api/canonical/')) return false;
    try {
      if (isFieldInputsRoute(url.pathname) || isInitiativeRoute(url.pathname)) res.removeHeader?.('Access-Control-Allow-Origin');
      if (production && !appOrigin) throw new ApiError(503, 'APP_ORIGIN is required in production');
      if (!isTrustedOrigin(req, appOrigin, production)) throw new ApiError(400, 'Untrusted Origin');
      if (req.headers.origin) res.setHeader?.('Access-Control-Allow-Origin', req.headers.origin);
      if ((isFieldInputsRoute(url.pathname) || isInitiativeRoute(url.pathname)) && req.method !== 'GET' && !req.headers.origin) throw new ApiError(400, 'Origin header is required');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
      if (isMergeReviewRoute(url.pathname)) requireMergeReviewToken(req, mergeReviewToken);
      if (!pool) throw new ApiError(503, 'Database unavailable');
      if (url.pathname === '/api/canonical/cutover-state') {
        if (req.method !== 'GET') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await readCutoverState(pool, env || process.env)); return true;
      }
      if (env && isCanonicalMutationRoute(req.method, url.pathname)) {
        const state = await readCutoverState(pool, env);
        if (state.stage !== 'canonical_active') throw new ApiError(409, 'Canonical cutover maintenance is active');
      }
      if (url.pathname === '/api/canonical/field-inputs') {
        if (req.method === 'GET') send(res, 200, await listFieldInputs(pool));
        else if (req.method === 'POST') send(res, 201, await createFieldInput(pool, req));
        else throw new ApiError(405, 'Method not allowed');
        return true;
      }
      if (url.pathname === '/api/canonical/initiatives') {
        if (req.method === 'GET') send(res, 200, await listInitiatives(pool));
        else if (req.method === 'POST') send(res, 201, await createInitiative(pool, req));
        else throw new ApiError(405, 'Method not allowed');
        return true;
      }
      const initiativeRoute = url.pathname.match(/^\/api\/canonical\/initiatives\/([^/]+)$/);
      if (initiativeRoute) {
        if (req.method !== 'PATCH') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await updateInitiative(pool, decodePath(initiativeRoute[1]), req)); return true;
      }
      if (url.pathname === '/api/canonical/field-inputs/bulk') {
        if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed');
        send(res, 201, await createFieldInputs(pool, req)); return true;
      }
      const fieldAction = url.pathname.match(/^\/api\/canonical\/field-inputs\/([^/]+)\/actions\/([^/]+)$/);
      if (fieldAction) {
        if (!['PATCH', 'DELETE'].includes(req.method)) throw new ApiError(405, 'Method not allowed');
        send(res, 200, await mutateAction(pool, decodePath(fieldAction[1]), decodePath(fieldAction[2]), req)); return true;
      }
      const fieldActions = url.pathname.match(/^\/api\/canonical\/field-inputs\/([^/]+)\/actions$/);
      if (fieldActions) {
        if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed');
        send(res, 201, await createAction(pool, decodePath(fieldActions[1]), req)); return true;
      }
      const fieldInput = url.pathname.match(/^\/api\/canonical\/field-inputs\/([^/]+)$/);
      if (fieldInput) {
        if (req.method === 'PATCH') send(res, 200, await editFieldInput(pool, decodePath(fieldInput[1]), req));
        else if (req.method === 'DELETE') send(res, 200, await deleteFieldInput(pool, decodePath(fieldInput[1]), req));
        else throw new ApiError(405, 'Method not allowed');
        return true;
      }
      if (url.pathname === '/api/canonical/feedback') {
        if (req.method === 'GET') send(res, 200, await listFeedback(pool, url));
        else if (req.method === 'POST') send(res, 201, await createFeedback(pool, req));
        else throw new ApiError(405, 'Method not allowed');
        return true;
      }
      if (url.pathname === '/api/canonical/duplicate-candidates/generate') {
        if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await generateDuplicateCandidates(pool, req));
        return true;
      }
      if (url.pathname === '/api/canonical/duplicate-candidates') {
        if (req.method !== 'GET') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await listDuplicateCandidates(pool, url));
        return true;
      }
      if (url.pathname === '/api/canonical/duplicate-groups') {
        if (req.method !== 'GET') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await listDuplicateGroups(pool, url));
        return true;
      }
      const rejectCandidate = url.pathname.match(/^\/api\/canonical\/duplicate-candidates\/([^/]+)\/reject$/);
      if (rejectCandidate) {
        if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await rejectDuplicateCandidate(pool, decodePath(rejectCandidate[1]), req));
        return true;
      }
      const confirmCandidate = url.pathname.match(/^\/api\/canonical\/duplicate-candidates\/([^/]+)\/confirm$/);
      if (confirmCandidate) {
        if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await confirmDuplicateCandidate(pool, decodePath(confirmCandidate[1]), req));
        return true;
      }
      const confirmGroup = url.pathname.match(/^\/api\/canonical\/duplicate-groups\/([^/]+)\/confirm$/);
      if (confirmGroup) {
        if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await confirmDuplicateGroup(pool, decodePath(confirmGroup[1]), req));
        return true;
      }
      const attach = url.pathname.match(/^\/api\/canonical\/feedback\/([^/]+)\/submissions$/);
      if (attach) {
        if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed');
        send(res, 201, await attachSubmission(pool, decodePath(attach[1]), req));
        return true;
      }
      const detail = url.pathname.match(/^\/api\/canonical\/feedback\/([^/]+)$/);
      if (detail) {
        if (req.method !== 'GET') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await detailFeedback(pool, decodePath(detail[1])));
        return true;
      }
      const mutation = url.pathname.match(/^\/api\/canonical\/submissions\/([^/]+)\/closed-loop$/);
      if (mutation) {
        if (req.method !== 'PATCH') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await mutateClosedLoop(pool, decodePath(mutation[1]), req));
        return true;
      }
      throw new ApiError(404, 'Canonical API route not found');
    } catch (error) {
      send(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
      return true;
    }
  };
}

module.exports = {
  createCanonicalApiHandler, listFeedback, detailFeedback, createFeedback, attachSubmission, mutateClosedLoop,
  listFieldInputs, createFieldInput, createFieldInputs, editFieldInput, deleteFieldInput, createAction, mutateAction,
  createInitiative, updateInitiative, listInitiatives,
  generateDuplicateCandidates, listDuplicateCandidates, listDuplicateGroups, rejectDuplicateCandidate, confirmDuplicateCandidate, confirmDuplicateGroup
  ,isCanonicalMutationRoute
};
