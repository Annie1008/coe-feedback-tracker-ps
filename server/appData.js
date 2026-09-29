const MAP_SIDECARS = new Set([
  'podNotes', 'podAssignments', 'timelineOverrides', 'timelineSuggestions', 'timelineNotes',
  'dumpedGroups', 'fixedGroups', 'manualJiraLinks', 'advisorEmails', 'providerEmails', 'peopleEmails',
  'quickClosedLoop'
]);
const REPLACE_SIDECARS = new Set(['jiraIssues', 'jiraSyncedAt', 'slackChannelId', '_savedAt']);

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

function mergeApprovedSidecars(current = {}, incoming = {}) {
  const result = { initiatives: current.initiatives || [], feedback: current.feedback || [], closedLoop: current.closedLoop || {} };
  for (const key of MAP_SIDECARS) result[key] = { ...object(current[key]), ...object(incoming[key]) };
  result.timelineHistory = Array.from(new Map([
    ...(Array.isArray(current.timelineHistory) ? current.timelineHistory : []),
    ...(Array.isArray(incoming.timelineHistory) ? incoming.timelineHistory : [])
  ].map(entry => [entry.id, entry])).values());
  for (const key of REPLACE_SIDECARS) {
    if (incoming[key] !== undefined) result[key] = incoming[key];
    else if (current[key] !== undefined) result[key] = current[key];
  }
  return result;
}

function validateAppDataWrite(data, headers, appOrigin, size = Buffer.byteLength(JSON.stringify(data)), { production = process.env.NODE_ENV === 'production' } = {}) {
  if (size > 1024 * 1024) throw Object.assign(new Error('Request body is too large'), { status: 413 });
  const origin = headers.origin;
  if (!origin) throw Object.assign(new Error('Origin header is required'), { status: 400 });
  if (production && !appOrigin) throw Object.assign(new Error('APP_ORIGIN is required in production'), { status: 500 });
  let trusted = false;
  try {
    const normalized = new URL(origin).origin;
    trusted = Boolean(appOrigin && normalized === new URL(appOrigin).origin);
    if (!production && !trusted) trusted = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized);
  } catch {}
  if (!trusted) throw Object.assign(new Error('Untrusted Origin'), { status: 400 });
  if (['initiatives', 'feedback', 'closedLoop'].some(key => Object.prototype.hasOwnProperty.call(data, key))) {
    throw Object.assign(new Error('Canonical Field Inputs cannot be written through /api/data'), { status: 409 });
  }
}

module.exports = { mergeApprovedSidecars, validateAppDataWrite };
