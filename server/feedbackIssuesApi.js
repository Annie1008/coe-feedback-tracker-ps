const crypto = require('node:crypto');

// Self-contained, same as server/canonicalApi.js and server/appData.js: this module
// duplicates the small request/validation helpers rather than reaching into canonicalApi's
// internals, since none of those are exported.
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FEEDBACK_TEXT = 20000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const STATUS_VALUES = ['untriaged', 'triaged', 'in_review', 'planned', 'in_progress', 'addressed', 'closed', 'not_actionable', 'duplicate'];
const PRIORITY_VALUES = ['low', 'medium', 'high', 'critical'];
const MEMBERSHIP_TYPE_VALUES = ['ai', 'human'];
const RELATIONSHIP_TYPE_VALUES = ['addresses', 'partially_addresses', 'blocked_by', 'duplicate_of', 'related_to', 'supersedes'];
const MATCH_SOURCE_VALUES = ['ai', 'human'];
const VERIFICATION_STATUS_VALUES = ['suggested', 'confirmed', 'rejected'];

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

function enumValue(value, field, allowed, { required = false, fallback } = {}) {
  if (value === undefined) {
    if (required) throw new ApiError(400, `${field} is required`);
    return fallback;
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ApiError(400, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function confidenceScore(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) {
    throw new ApiError(400, `${field} must be a number between 0 and 1`);
  }
  return value;
}

function nonnegativeVersion(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new ApiError(400, `${field} must be a nonnegative integer`);
  return value;
}

function validInstant(value, field) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, `${field} must be a valid ISO instant or null`);
  }
  return value;
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, 'Malformed path encoding');
  }
}

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

// Deliberately not gated by server/cutoverState.js's canonical_cutover_state / beginWrite():
// that hold is specific to the Field Inputs legacy migration (stuck in legacy_read_only
// pending Megan's go-ahead, see project memory) and is unrelated to this new feedback-issue
// entity. Gating this on that hold would make the feature unusable for as long as that hold
// lasts, which contradicts it being the first, most important thing to make rock-solid.
// scripts/activate-canonical-cutover.js's integrity hash only covers app_data's legacy
// payload blob, not canonical_feedback rows, so writes here (including setting the new
// canonical_feedback.feedback_issue_id column) cannot disturb that hold's invariant either.
async function beginIssueWrite(client, statementTimeout = '15s') {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query(`SET LOCAL statement_timeout = '${statementTimeout}'`);
}

function feedbackIssue(row) {
  return {
    id: row.id,
    initiativeId: row.initiative_id,
    title: row.title,
    canonicalText: row.canonical_text,
    status: row.status,
    priority: row.priority,
    ownerUserId: row.owner_user_id,
    firstReportedAt: row.first_reported_at,
    lastReportedAt: row.last_reported_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    retiredAt: row.retired_at,
    ...(row.member_count !== undefined ? { memberCount: Number(row.member_count) } : {}),
    ...(row.delivery_link_count !== undefined ? { deliveryLinkCount: Number(row.delivery_link_count) } : {})
  };
}

function member(row) {
  return {
    feedbackIssueId: row.feedback_issue_id,
    canonicalFeedbackId: row.canonical_feedback_id,
    canonicalText: row.canonical_text,
    membershipType: row.membership_type,
    confidence: row.confidence === null ? null : Number(row.confidence),
    verified: row.verified,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    createdAt: row.created_at
  };
}

function deliveryLink(row) {
  return {
    id: row.id,
    feedbackIssueId: row.feedback_issue_id,
    provider: row.provider,
    externalKey: row.external_key,
    relationshipType: row.relationship_type,
    matchSource: row.match_source,
    confidence: row.confidence === null ? null : Number(row.confidence),
    verificationStatus: row.verification_status,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function statusHistoryEntry(row) {
  return {
    id: row.id,
    feedbackIssueId: row.feedback_issue_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    source: row.source,
    reason: row.reason,
    changedBy: row.changed_by,
    createdAt: row.created_at
  };
}

async function recordStatusTransition(client, issueId, fromStatus, toStatus, { source = 'human', reason = null, changedBy = null } = {}) {
  await client.query(`INSERT INTO feedback_issue_status_history (id, feedback_issue_id, from_status, to_status, source, reason, changed_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [crypto.randomUUID(), issueId, fromStatus, toStatus, source, reason, changedBy]);
}

async function createFeedbackIssue(pool, req) {
  const body = await parseBody(req);
  const initiativeId = boundedString(body.initiativeId, 'initiativeId', 200, { required: true });
  const title = boundedString(body.title, 'title', 500, { required: true });
  const canonicalText = boundedString(body.canonicalText, 'canonicalText', MAX_FEEDBACK_TEXT, { required: true });
  const status = enumValue(body.status, 'status', STATUS_VALUES, { fallback: 'untriaged' });
  const priority = enumValue(body.priority, 'priority', PRIORITY_VALUES, { fallback: 'medium' });
  const ownerUserId = boundedString(body.ownerUserId, 'ownerUserId', 200) || null;
  const firstReportedAt = validInstant(body.firstReportedAt, 'firstReportedAt') || null;
  const lastReportedAt = validInstant(body.lastReportedAt, 'lastReportedAt') || null;
  const id = body.id ? optionalString(body.id, 'id') : crypto.randomUUID();

  const client = await pool.connect();
  try {
    await beginIssueWrite(client);
    const initiative = await client.query('SELECT id FROM initiatives WHERE id=$1', [initiativeId]);
    if (!initiative.rows[0]) throw new ApiError(400, 'initiativeId does not reference an existing initiative');
    const result = await client.query(`INSERT INTO feedback_issues
      (id, initiative_id, title, canonical_text, status, priority, owner_user_id, first_reported_at, last_reported_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [id, initiativeId, title, canonicalText, status, priority, ownerUserId, firstReportedAt, lastReportedAt]);
    await recordStatusTransition(client, id, null, status, { changedBy: optionalString(body.changedBy, 'changedBy') || null });
    await client.query('COMMIT');
    return feedbackIssue(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listFeedbackIssues(pool, url) {
  const initiativeId = url.searchParams.get('initiativeId');
  const status = url.searchParams.get('status');
  if (status !== null && !STATUS_VALUES.includes(status)) throw new ApiError(400, `status must be one of: ${STATUS_VALUES.join(', ')}`);
  const result = await pool.query(`
    SELECT fi.*, COALESCE(m.member_count, 0) AS member_count, COALESCE(d.delivery_link_count, 0) AS delivery_link_count
    FROM feedback_issues fi
    LEFT JOIN LATERAL (SELECT COUNT(*)::int AS member_count FROM feedback_issue_members WHERE feedback_issue_id = fi.id) m ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*)::int AS delivery_link_count FROM feedback_issue_delivery_links WHERE feedback_issue_id = fi.id) d ON TRUE
    WHERE ($1::TEXT IS NULL OR fi.initiative_id = $1) AND ($2::TEXT IS NULL OR fi.status = $2)
    ORDER BY fi.updated_at DESC, fi.id`, [initiativeId, status]);
  return { items: result.rows.map(feedbackIssue) };
}

async function getFeedbackIssue(pool, id) {
  const issueResult = await pool.query('SELECT * FROM feedback_issues WHERE id=$1', [id]);
  if (!issueResult.rows[0]) throw new ApiError(404, 'Feedback issue not found');
  const [membersResult, linksResult, historyResult] = await Promise.all([
    pool.query(`SELECT fim.*, cf.canonical_text FROM feedback_issue_members fim
      JOIN canonical_feedback cf ON cf.id = fim.canonical_feedback_id
      WHERE fim.feedback_issue_id=$1 ORDER BY fim.created_at`, [id]),
    pool.query('SELECT * FROM feedback_issue_delivery_links WHERE feedback_issue_id=$1 ORDER BY created_at', [id]),
    pool.query('SELECT * FROM feedback_issue_status_history WHERE feedback_issue_id=$1 ORDER BY created_at, id', [id])
  ]);
  return {
    ...feedbackIssue(issueResult.rows[0]),
    members: membersResult.rows.map(member),
    deliveryLinks: linksResult.rows.map(deliveryLink),
    statusHistory: historyResult.rows.map(statusHistoryEntry)
  };
}

async function updateFeedbackIssue(pool, id, req) {
  const body = await parseBody(req);
  nonnegativeVersion(body.expectedVersion, 'expectedVersion');
  const title = body.title !== undefined ? boundedString(body.title, 'title', 500, { required: true }) : undefined;
  const canonicalText = body.canonicalText !== undefined ? boundedString(body.canonicalText, 'canonicalText', MAX_FEEDBACK_TEXT, { required: true }) : undefined;
  const status = enumValue(body.status, 'status', STATUS_VALUES);
  const priority = enumValue(body.priority, 'priority', PRIORITY_VALUES);
  const ownerUserIdProvided = body.ownerUserId !== undefined;
  const ownerUserId = ownerUserIdProvided ? (boundedString(body.ownerUserId, 'ownerUserId', 200, { nullable: true }) || null) : null;
  const firstReportedAtProvided = body.firstReportedAt !== undefined;
  const firstReportedAt = firstReportedAtProvided ? validInstant(body.firstReportedAt, 'firstReportedAt') : null;
  const lastReportedAtProvided = body.lastReportedAt !== undefined;
  const lastReportedAt = lastReportedAtProvided ? validInstant(body.lastReportedAt, 'lastReportedAt') : null;
  const retiredAtProvided = body.retiredAt !== undefined;
  const retiredAt = retiredAtProvided ? validInstant(body.retiredAt, 'retiredAt') : null;

  const client = await pool.connect();
  try {
    await beginIssueWrite(client);
    const current = await client.query('SELECT status FROM feedback_issues WHERE id=$1 FOR UPDATE', [id]);
    if (!current.rows[0]) throw new ApiError(404, 'Feedback issue not found');
    const previousStatus = current.rows[0].status;

    const result = await client.query(`UPDATE feedback_issues SET
        title = COALESCE($3, title),
        canonical_text = COALESCE($4, canonical_text),
        status = COALESCE($5, status),
        priority = COALESCE($6, priority),
        owner_user_id = CASE WHEN $7::BOOLEAN THEN $8 ELSE owner_user_id END,
        first_reported_at = CASE WHEN $9::BOOLEAN THEN $10 ELSE first_reported_at END,
        last_reported_at = CASE WHEN $11::BOOLEAN THEN $12 ELSE last_reported_at END,
        retired_at = CASE WHEN $13::BOOLEAN THEN $14 ELSE retired_at END,
        version = version + 1,
        updated_at = NOW()
      WHERE id=$1 AND version=$2
      RETURNING *`,
    [id, body.expectedVersion, title ?? null, canonicalText ?? null, status ?? null, priority ?? null,
      ownerUserIdProvided, ownerUserId, firstReportedAtProvided, firstReportedAt,
      lastReportedAtProvided, lastReportedAt, retiredAtProvided, retiredAt]);
    if (!result.rows[0]) throw new ApiError(409, 'Feedback issue version is stale or missing');

    if (status && status !== previousStatus) {
      await recordStatusTransition(client, id, previousStatus, status, {
        reason: optionalString(body.statusChangeReason, 'statusChangeReason') || null,
        changedBy: optionalString(body.changedBy, 'changedBy') || null
      });
    }
    await client.query('COMMIT');
    return feedbackIssue(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function upsertFeedbackIssueMember(pool, issueId, req) {
  const body = await parseBody(req);
  const canonicalFeedbackId = boundedString(body.canonicalFeedbackId, 'canonicalFeedbackId', 200, { required: true });
  const membershipType = enumValue(body.membershipType, 'membershipType', MEMBERSHIP_TYPE_VALUES, { fallback: 'ai' });
  const confidence = confidenceScore(body.confidence, 'confidence');
  const verified = body.verified === undefined ? false : Boolean(body.verified);
  const verifiedBy = boundedString(body.verifiedBy, 'verifiedBy', 200) || null;
  const verifiedAt = verified ? (validInstant(body.verifiedAt, 'verifiedAt') || new Date().toISOString()) : null;

  const client = await pool.connect();
  try {
    await beginIssueWrite(client);
    const issue = await client.query('SELECT id FROM feedback_issues WHERE id=$1', [issueId]);
    if (!issue.rows[0]) throw new ApiError(404, 'Feedback issue not found');
    const canonical = await client.query('SELECT id FROM canonical_feedback WHERE id=$1', [canonicalFeedbackId]);
    if (!canonical.rows[0]) throw new ApiError(400, 'canonicalFeedbackId does not reference an existing canonical feedback record');

    const result = await client.query(`INSERT INTO feedback_issue_members
        (feedback_issue_id, canonical_feedback_id, membership_type, confidence, verified, verified_by, verified_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (feedback_issue_id, canonical_feedback_id) DO UPDATE SET
        membership_type = EXCLUDED.membership_type,
        confidence = EXCLUDED.confidence,
        verified = EXCLUDED.verified,
        verified_by = EXCLUDED.verified_by,
        verified_at = EXCLUDED.verified_at
      RETURNING *`,
    [issueId, canonicalFeedbackId, membershipType, confidence, verified, verifiedBy, verifiedAt]);

    // Denormalized shortcut (migrations/008): last membership written for a given
    // canonical_feedback row wins as its "primary" feedback issue.
    await client.query('UPDATE canonical_feedback SET feedback_issue_id=$1 WHERE id=$2', [issueId, canonicalFeedbackId]);

    await client.query('COMMIT');
    return member({ ...result.rows[0], canonical_text: null });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function upsertDeliveryLink(pool, issueId, req) {
  const body = await parseBody(req);
  const provider = boundedString(body.provider, 'provider', 100, { required: true });
  const externalKey = boundedString(body.externalKey, 'externalKey', 200, { required: true });
  const relationshipType = enumValue(body.relationshipType, 'relationshipType', RELATIONSHIP_TYPE_VALUES, { required: true });
  const matchSource = enumValue(body.matchSource, 'matchSource', MATCH_SOURCE_VALUES, { required: true });
  const confidence = confidenceScore(body.confidence, 'confidence');
  const verificationStatus = enumValue(body.verificationStatus, 'verificationStatus', VERIFICATION_STATUS_VALUES, { fallback: 'suggested' });
  const id = crypto.randomUUID();

  const client = await pool.connect();
  try {
    await beginIssueWrite(client);
    const issue = await client.query('SELECT id FROM feedback_issues WHERE id=$1', [issueId]);
    if (!issue.rows[0]) throw new ApiError(404, 'Feedback issue not found');

    const result = await client.query(`INSERT INTO feedback_issue_delivery_links
        (id, feedback_issue_id, provider, external_key, relationship_type, match_source, confidence, verification_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (feedback_issue_id, provider, external_key) DO UPDATE SET
        relationship_type = EXCLUDED.relationship_type,
        match_source = EXCLUDED.match_source,
        confidence = EXCLUDED.confidence,
        verification_status = EXCLUDED.verification_status,
        updated_at = NOW()
      RETURNING *`,
    [id, issueId, provider, externalKey, relationshipType, matchSource, confidence, verificationStatus]);

    await client.query('COMMIT');
    return deliveryLink(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateDeliveryLink(pool, issueId, linkId, req) {
  const body = await parseBody(req);
  const verificationStatus = enumValue(body.verificationStatus, 'verificationStatus', VERIFICATION_STATUS_VALUES, { required: true });
  const confirmedBy = boundedString(body.confirmedBy, 'confirmedBy', 200) || null;
  const confirmedAt = ['confirmed', 'rejected'].includes(verificationStatus) ? new Date().toISOString() : null;

  const client = await pool.connect();
  try {
    await beginIssueWrite(client);
    const result = await client.query(`UPDATE feedback_issue_delivery_links
      SET verification_status=$3, confirmed_by=$4, confirmed_at=$5, updated_at=NOW()
      WHERE id=$1 AND feedback_issue_id=$2 RETURNING *`,
    [linkId, issueId, verificationStatus, confirmedBy, confirmedAt]);
    if (!result.rows[0]) throw new ApiError(404, 'Delivery link not found');
    await client.query('COMMIT');
    return deliveryLink(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function createFeedbackIssuesApiHandler({ pool, appOrigin = process.env.APP_ORIGIN, production = process.env.NODE_ENV === 'production' } = {}) {
  return async function feedbackIssuesApiHandler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return false;
    }
    if (!url.pathname.startsWith('/api/feedback-issues')) return false;
    try {
      if (!isTrustedOrigin(req, appOrigin, production)) throw new ApiError(400, 'Untrusted Origin');
      if (req.method !== 'GET' && req.method !== 'OPTIONS' && !req.headers.origin) throw new ApiError(400, 'Origin header is required');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
      if (!pool) throw new ApiError(503, 'Database unavailable');

      if (url.pathname === '/api/feedback-issues') {
        if (req.method === 'GET') send(res, 200, await listFeedbackIssues(pool, url));
        else if (req.method === 'POST') send(res, 201, await createFeedbackIssue(pool, req));
        else throw new ApiError(405, 'Method not allowed');
        return true;
      }

      const members = url.pathname.match(/^\/api\/feedback-issues\/([^/]+)\/members$/);
      if (members) {
        if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await upsertFeedbackIssueMember(pool, decodePath(members[1]), req));
        return true;
      }

      const createLink = url.pathname.match(/^\/api\/feedback-issues\/([^/]+)\/delivery-links$/);
      if (createLink) {
        if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await upsertDeliveryLink(pool, decodePath(createLink[1]), req));
        return true;
      }

      const updateLink = url.pathname.match(/^\/api\/feedback-issues\/([^/]+)\/delivery-links\/([^/]+)$/);
      if (updateLink) {
        if (req.method !== 'PATCH') throw new ApiError(405, 'Method not allowed');
        send(res, 200, await updateDeliveryLink(pool, decodePath(updateLink[1]), decodePath(updateLink[2]), req));
        return true;
      }

      const detail = url.pathname.match(/^\/api\/feedback-issues\/([^/]+)$/);
      if (detail) {
        if (req.method === 'GET') send(res, 200, await getFeedbackIssue(pool, decodePath(detail[1])));
        else if (req.method === 'PATCH') send(res, 200, await updateFeedbackIssue(pool, decodePath(detail[1]), req));
        else throw new ApiError(405, 'Method not allowed');
        return true;
      }

      throw new ApiError(404, 'Feedback issues API route not found');
    } catch (error) {
      send(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
      return true;
    }
  };
}

module.exports = {
  createFeedbackIssuesApiHandler,
  listFeedbackIssues, createFeedbackIssue, getFeedbackIssue, updateFeedbackIssue,
  upsertFeedbackIssueMember, upsertDeliveryLink, updateDeliveryLink
};
