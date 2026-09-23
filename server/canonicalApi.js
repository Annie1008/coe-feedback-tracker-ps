const crypto = require('node:crypto');

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SOURCE_DATA_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SOURCE_DATA_FIELDS = ['sourceType', 'sourceName', 'externalId'];
const LOOP_STRING_FIELDS = ['howIncorporated', 'communicationMethod', 'notes'];

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
    closedDate: row.closed_date,
    closed: Boolean(row.closed),
    notes: row.notes,
    version: row.closed_loop_version
  };
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
  const where = [];
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
      WHERE fs.canonical_feedback_id = cf.id
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
      WHERE fs.canonical_feedback_id = cf.id
    ) stats ON TRUE
    WHERE cf.id = $1`, [id]);
  if (!result.rows[0]) throw new ApiError(404, 'Feedback not found');
  const submissions = await pool.query(`
    SELECT fs.id, fs.provider_snapshot, fs.source_data, fs.submitted_on, fs.source_created_at, fs.version,
      cl.id AS closed_loop_id, cl.how_incorporated, cl.communicated_back, cl.communication_method,
      cl.closed_date, cl.closed, cl.notes, cl.version AS closed_loop_version
    FROM feedback_submissions fs
    LEFT JOIN closed_loops cl ON cl.feedback_submission_id = fs.id
    WHERE fs.canonical_feedback_id = $1
    ORDER BY fs.created_at, fs.id`, [id]);
  return {
    ...canonical(result.rows[0]),
    submissions: submissions.rows.map(row => ({
      id: row.id, provider: row.provider_snapshot, sourceData: publicSourceData(row.source_data),
      submittedOn: row.submitted_on, sourceCreatedAt: row.source_created_at, version: row.version,
      closedLoop: loop(row)
    }))
  };
}

function requestHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

async function beginWrite(client) {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '15s'");
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
    sourceData: sourceData(body.sourceData)
  };
}

async function createFeedback(pool, req) {
  const key = idempotencyKey(req);
  const body = await parseBody(req);
  const submission = validateSubmission(body);
  if (typeof body.canonicalText !== 'string' || !body.canonicalText.trim()) throw new ApiError(400, 'canonicalText is required');
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
      [id, submission.initiativeId, body.title ?? null, body.canonicalText.trim()]);
    await client.query('SELECT id FROM canonical_feedback WHERE id = $1 FOR UPDATE', [id]);
    await client.query(`
      INSERT INTO feedback_submissions
        (id, canonical_feedback_id, initiative_id, provider_snapshot, source_data, submitted_on, source_created_at)
      VALUES ($1, $2, $3, $4, $5, $6::DATE, $7::TIMESTAMPTZ)`,
    [submission.submissionId, id, submission.initiativeId, submission.provider, submission.sourceData, submission.date, submission.sourceCreatedAt]);
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
    const parent = await client.query('SELECT id, initiative_id FROM canonical_feedback WHERE id = $1 FOR UPDATE', [canonicalId]);
    if (!parent.rows[0]) throw new ApiError(404, 'Feedback not found');
    const parentInitiativeId = parent.rows[0].initiative_id || null;
    if (body.initiativeId !== undefined && parentInitiativeId !== submission.initiativeId) throw new ApiError(409, 'Submission initiative does not match canonical feedback');
    await client.query(`
      INSERT INTO feedback_submissions
        (id, canonical_feedback_id, initiative_id, provider_snapshot, source_data, submitted_on, source_created_at)
      VALUES ($1, $2, $3, $4, $5, $6::DATE, $7::TIMESTAMPTZ)`,
    [submission.submissionId, canonicalId, parentInitiativeId, submission.provider, submission.sourceData, submission.date, submission.sourceCreatedAt]);
    const response = { id: submission.submissionId, canonicalFeedbackId: canonicalId, canonicalClosed: false };
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
  const body = await parseBody(req);
  validateLoopPatch(body);
  const client = await pool.connect();
  try {
    await beginWrite(client);
    const parent = await client.query(`
      SELECT cf.id AS canonical_feedback_id
      FROM canonical_feedback cf
      JOIN feedback_submissions fs ON fs.canonical_feedback_id = cf.id
      WHERE fs.id = $1
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
      SELECT EXISTS (SELECT 1 FROM feedback_submissions WHERE canonical_feedback_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM feedback_submissions fs LEFT JOIN closed_loops cl ON cl.feedback_submission_id = fs.id
          WHERE fs.canonical_feedback_id = $1 AND COALESCE(cl.closed, FALSE) = FALSE
        ) AS closed`, [canonicalId]);
    await client.query('COMMIT');
    return { closedLoop: loop(changed.rows[0]), canonicalClosed: Boolean(status.rows[0].closed) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function isTrustedOrigin(req, appOrigin) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    if (appOrigin && new URL(origin).origin === new URL(appOrigin).origin) return true;
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function createCanonicalApiHandler({ pool, appOrigin = process.env.APP_ORIGIN }) {
  return async function canonicalApiHandler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return false;
    }
    if (!url.pathname.startsWith('/api/canonical/')) return false;
    try {
      if (!isTrustedOrigin(req, appOrigin)) throw new ApiError(400, 'Untrusted Origin');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
      if (!pool) throw new ApiError(503, 'Database unavailable');
      if (url.pathname === '/api/canonical/feedback') {
        if (req.method === 'GET') send(res, 200, await listFeedback(pool, url));
        else if (req.method === 'POST') send(res, 201, await createFeedback(pool, req));
        else throw new ApiError(405, 'Method not allowed');
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

module.exports = { createCanonicalApiHandler, listFeedback, detailFeedback, createFeedback, attachSubmission, mutateClosedLoop };
