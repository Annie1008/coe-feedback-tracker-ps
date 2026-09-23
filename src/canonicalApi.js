const API_BASE = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001';

export class CanonicalApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'CanonicalApiError';
    this.status = status;
  }
}

async function requestJson(path, { token, method = 'GET', body, idempotencyKey, fetchImpl = fetch } = {}) {
  const headers = { 'x-merge-review-token': token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetchImpl(`${API_BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let json;
  try {
    json = await response.json();
  } catch {
    throw new CanonicalApiError(`The server returned an invalid response (HTTP ${response.status}).`, response.status);
  }
  if (!response.ok) throw new CanonicalApiError(json.error || `Request failed (HTTP ${response.status}).`, response.status);
  return json;
}

export function listCandidates({ initiativeId, token, cursor, fetchImpl }) {
  const query = new URLSearchParams({ initiativeId, status: 'pending', limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return requestJson(`/api/canonical/duplicate-candidates?${query}`, { token, fetchImpl });
}

export function generateCandidates({ initiativeId, token, fetchImpl, randomUUID = () => globalThis.crypto.randomUUID() }) {
  return requestJson('/api/canonical/duplicate-candidates/generate', {
    token, method: 'POST', fetchImpl, idempotencyKey: randomUUID(),
    body: { initiativeId, threshold: 0.45, limitPerItem: 10 }
  });
}

export function rejectCandidate({ candidate, reason, token, fetchImpl, randomUUID = () => globalThis.crypto.randomUUID() }) {
  return requestJson(`/api/canonical/duplicate-candidates/${encodeURIComponent(candidate.id)}/reject`, {
    token, method: 'POST', fetchImpl, idempotencyKey: randomUUID(),
    body: { expectedVersion: candidate.version, reason: reason.trim() }
  });
}

export function confirmCandidate({ candidate, winnerId, reason, token, fetchImpl, randomUUID = () => globalThis.crypto.randomUUID() }) {
  const winner = candidate.left.id === winnerId ? candidate.left : candidate.right;
  const loser = candidate.left.id === winnerId ? candidate.right : candidate.left;
  return requestJson(`/api/canonical/duplicate-candidates/${encodeURIComponent(candidate.id)}/confirm`, {
    token, method: 'POST', fetchImpl, idempotencyKey: randomUUID(),
    body: {
      winnerId: winner.id,
      loserId: loser.id,
      expectedVersion: candidate.version,
      expectedWinnerVersion: winner.version,
      expectedLoserVersion: loser.version,
      reason: reason.trim()
    }
  });
}
