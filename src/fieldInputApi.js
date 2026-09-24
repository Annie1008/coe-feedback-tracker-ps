const API_BASE = '';

function key() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-field-input`;
}

async function request(path, { method = 'GET', body, idempotent = false } = {}) {
  const response = await fetch(`${API_BASE}/api/canonical${path}`, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(idempotent && { 'Idempotency-Key': key() }) },
    ...(body && { body: JSON.stringify(body) })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}

export const listFieldInputs = () => request('/field-inputs');
export const getCutoverState = () => request('/cutover-state');
export const listInitiatives = () => request('/initiatives');
export const createFieldInput = value => request('/field-inputs', { method: 'POST', body: value, idempotent: true });
export const createFieldInputs = values => request('/field-inputs/bulk', { method: 'POST', body: { items: values }, idempotent: true });
export const updateFieldInput = (submissionId, value) => request(`/field-inputs/${encodeURIComponent(submissionId)}`, { method: 'PATCH', body: value });
export const deleteFieldInput = (submissionId, expectedVersion) => request(`/field-inputs/${encodeURIComponent(submissionId)}`, { method: 'DELETE', body: { expectedVersion } });
export const createFieldAction = (submissionId, text) => request(`/field-inputs/${encodeURIComponent(submissionId)}/actions`, { method: 'POST', body: { text }, idempotent: true });
export const updateFieldAction = (submissionId, actionId, value) => request(`/field-inputs/${encodeURIComponent(submissionId)}/actions/${encodeURIComponent(actionId)}`, { method: 'PATCH', body: value });
export const deleteFieldAction = (submissionId, actionId, expectedVersion) => request(`/field-inputs/${encodeURIComponent(submissionId)}/actions/${encodeURIComponent(actionId)}`, { method: 'DELETE', body: { expectedVersion } });
export const updateFieldLoop = (submissionId, value) => request(`/submissions/${encodeURIComponent(submissionId)}/closed-loop`, { method: 'PATCH', body: value, idempotent: true });
export const createInitiative = value => request('/initiatives', { method: 'POST', body: value });
export const updateInitiative = (id, value) => request(`/initiatives/${encodeURIComponent(id)}`, { method: 'PATCH', body: value });
