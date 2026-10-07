const http = require('http');
const fs = require('fs');
const path = require('path');
const { createPool } = require('./server/db');
const { createCanonicalApiHandler } = require('./server/canonicalApi');
const { createFeedbackIssuesApiHandler } = require('./server/feedbackIssuesApi');
const { mergeApprovedSidecars, validateAppDataWrite } = require('./server/appData');
const { readCutoverState, CUTOVER_LOCK_ID } = require('./server/cutoverState');

const PORT = process.env.PORT || 3001;
const IS_PROD = process.env.NODE_ENV === 'production';

// Live Jira connection — kept server-side only, same reasoning as the AI key above: the token
// never reaches the browser, so the sync feature just works for everyone against one shared
// Jira account rather than requiring each person's own token.
const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || '';
// Catch-all Epic that every ticket created via "+ Create Jira Story" gets filed under, so
// app-created tickets stay grouped and visually separate from the rest of the backlog.
const JIRA_EPIC_KEY = process.env.JIRA_EPIC_KEY || '';
// customfield_10014 = "Epic Link" on this Jira instance (SEPSP is a classic/company-managed
// project, so Stories attach to Epics via this custom field rather than fields.parent).
const JIRA_EPIC_LINK_FIELD = 'customfield_10014';
// The specific board the team actually works against (e.g. https://.../boards/435). Scoping to
// this board instead of the whole SEPSP project matters: the project key is shared across
// multiple unrelated teams (plain `project = SEPSP` pulls 1700+ issues), while this board's own
// Summary tab reports ~247 work items total — that's the real "SolutionIQ and Scoping Team" set.
// Unlike the original version of this scoping, this now includes closed sprints (not just
// active/future) so historical/done tickets don't drop out of the sync once their sprint closes.
const JIRA_BOARD_ID = process.env.JIRA_BOARD_ID || '';

function jiraAuthHeader() {
  return 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
}

async function jiraGet(urlPath) {
  const res = await fetch(`${JIRA_BASE_URL}${urlPath}`, { headers: { Authorization: jiraAuthHeader() } });
  if (!res.ok) throw new Error(`Jira request failed: ${res.status} ${await res.text()} (${urlPath})`);
  return res.json();
}

// Slack bot token — kept server-side only, same reasoning as the Jira token above. Every call
// into these helpers only ever happens because a person clicked an explicit "Send"/"Confirm"
// button in the UI; nothing on this server schedules or auto-fires a Slack message on its own.
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';

async function slackGet(method, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || `Slack ${method} failed`);
  return json;
}

async function slackPost(method, params) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || `Slack ${method} failed`);
  return json;
}

// The Sprint field is a custom field whose id varies by Jira instance — resolved once via the
// field API and cached in memory, falling back to the common default id if the lookup ever
// fails, so a transient field-API hiccup doesn't break the whole sync.
let sprintFieldIdCache = null;
async function getSprintFieldId() {
  if (sprintFieldIdCache) return sprintFieldIdCache;
  try {
    const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/field`, { headers: { Authorization: jiraAuthHeader() } });
    const fields = await res.json();
    const match = Array.isArray(fields) ? fields.find(f => f.name === 'Sprint') : null;
    sprintFieldIdCache = match?.id || 'customfield_10020';
  } catch {
    sprintFieldIdCache = 'customfield_10020';
  }
  return sprintFieldIdCache;
}

// Flattens Atlassian Document Format (Jira's rich-text description shape) into plain text —
// only the text leaves matter for matching against feedback, not the formatting structure.
function adfToText(node) {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray(node.content)) return node.content.map(adfToText).join(' ');
  return '';
}

// Inverse of adfToText — Jira Cloud's v3 create-issue API requires description in ADF, not
// plain text, even for a single paragraph.
function textToADF(text) {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] };
}

// Resolution name plus the most recent comment — so the Tracker can show *why*/*how* an item
// was resolved on the Jira side, not just that its status is Done.
function resolutionInfo(fields) {
  const comments = fields.comment?.comments || [];
  const lastComment = comments.length ? adfToText(comments[comments.length - 1].body).replace(/\s+/g, ' ').trim() : '';
  return { resolution: fields.resolution?.name || '', resolutionNote: lastComment };
}

// A story can carry 0+ sprints (it moves between sprints over its life) — pick the one that
// best represents "when is/was this happening": an active sprint (happening now) beats a
// future one (planned ahead), which beats the most recent closed one (already shipped), so
// downstream code's single `sprint` field reflects the most actionable timing.
function pickRelevantSprint(sprints) {
  if (!Array.isArray(sprints) || sprints.length === 0) return null;
  const active = sprints.find(s => s.state === 'active');
  if (active) return active;
  const future = sprints.filter(s => s.state === 'future').sort((a, b) => new Date(a.startDate) - new Date(b.startDate))[0];
  if (future) return future;
  const closed = sprints.filter(s => s.state === 'closed').sort((a, b) => new Date(b.endDate) - new Date(a.endDate))[0];
  return closed || null;
}

// This board tags many tickets with a "release::<target>" label (e.g. "release::sept30",
// "release::oct", "release::backlog") that's set independently of the Agile Sprint field —
// verified against real tickets that had no Sprint value at all but did carry one of these,
// so it's the team's actual target-date signal for anything not yet slotted into a sprint.
function releaseLabel(labels) {
  const found = (labels || []).find(l => /^release::/i.test(l));
  return found ? found.slice('release::'.length).toLowerCase() : '';
}

function normalizeJiraIssue(issue, sprint) {
  return {
    key: issue.key,
    summary: issue.fields.summary || '',
    status: issue.fields.status?.name || '',
    statusCategory: issue.fields.status?.statusCategory?.key || '',
    issueType: issue.fields.issuetype?.name || '',
    parentKey: issue.fields.parent?.key || '',
    parentSummary: issue.fields.parent?.fields?.summary || '',
    sprint: sprint?.name || '',
    sprintState: sprint?.state || '',
    release: releaseLabel(issue.fields.labels),
    labels: issue.fields.labels || [],
    priority: issue.fields.priority?.name || '',
    fixVersion: (issue.fields.fixVersions || []).map(v => v.name).join(', '),
    description: adfToText(issue.fields.description).replace(/\s+/g, ' ').trim(),
    updated: issue.fields.updated || '',
    ...resolutionInfo(issue.fields)
  };
}

async function fetchBoardSprints(boardId) {
  const sprints = [];
  let startAt = 0;
  for (;;) {
    const page = await jiraGet(`/rest/agile/1.0/board/${boardId}/sprint?maxResults=50&startAt=${startAt}`);
    sprints.push(...(page.values || []));
    if (page.isLast || !page.values || page.values.length === 0) break;
    startAt += page.values.length;
  }
  return sprints;
}

async function fetchSprintIssues(boardId, sprint, fields) {
  const issues = [];
  let startAt = 0;
  for (;;) {
    const page = await jiraGet(`/rest/agile/1.0/board/${boardId}/sprint/${sprint.id}/issue?maxResults=100&startAt=${startAt}&fields=${fields}`);
    (page.issues || []).forEach(issue => issues.push(normalizeJiraIssue(issue, sprint)));
    if (!page.issues || page.issues.length === 0 || startAt + page.issues.length >= page.total) break;
    startAt += page.issues.length;
  }
  return issues;
}

// Mirrors what the board is actually being planned against: the active sprint, future sprints,
// and the unscheduled backlog. Deliberately excludes closed sprints — the board goes back years
// and has 80-90+ closed sprints; pulling all of them both produced false-positive feedback matches
// and, fetched one at a time, blew past Heroku's 30s router timeout (H12s observed in production).
// "Closed" tickets aren't actually missing from this: a ticket can carry status=Done/Closed while
// still sitting in the active sprint or backlog (common until it's formally archived) — verified
// against Jira's own board Summary count (247 total) landing within a few tickets of this scope
// (233), vs. 1149 when closed sprints are included.
async function fetchAllBoardIssues(boardId) {
  const fields = 'summary,status,issuetype,parent,description,updated,labels,resolution,comment,priority,fixVersions';
  const byKey = new Map();
  const CONCURRENCY = 10;

  const allSprints = await fetchBoardSprints(boardId);
  const sprints = allSprints.filter(s => s.state !== 'closed');
  for (let i = 0; i < sprints.length; i += CONCURRENCY) {
    const batch = sprints.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(sprint => fetchSprintIssues(boardId, sprint, fields)));
    batchResults.forEach(issues => issues.forEach(issue => byKey.set(issue.key, issue)));
  }

  let startAt = 0;
  for (;;) {
    const page = await jiraGet(`/rest/agile/1.0/board/${boardId}/backlog?maxResults=100&startAt=${startAt}&fields=${fields}`);
    (page.issues || []).forEach(issue => byKey.set(issue.key, normalizeJiraIssue(issue, null)));
    if (!page.issues || page.issues.length === 0 || startAt + page.issues.length >= page.total) break;
    startAt += page.issues.length;
  }

  return Array.from(byKey.values());
}

// Pulls every ticket in the whole project — fallback for when no specific board is configured.
async function fetchAllJiraIssues() {
  const sprintFieldId = await getSprintFieldId();
  const fields = ['summary', 'status', 'issuetype', 'parent', 'description', 'updated', sprintFieldId, 'resolution', 'comment', 'priority', 'fixVersions', 'labels'];
  const issues = [];
  let nextPageToken;
  for (;;) {
    const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: jiraAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql: `project = ${JIRA_PROJECT_KEY} ORDER BY updated DESC`,
        maxResults: 100,
        nextPageToken,
        fields
      })
    });
    if (!res.ok) throw new Error(`Jira search failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    (page.issues || []).forEach(issue => {
      const sprint = pickRelevantSprint(issue.fields[sprintFieldId]);
      issues.push(normalizeJiraIssue(issue, sprint));
    });
    if (page.isLast || !page.issues || page.issues.length === 0 || !page.nextPageToken) break;
    nextPageToken = page.nextPageToken;
  }
  return issues;
}

// Heroku Postgres schema is applied by the release-phase migration command.
const pool = createPool();
const canonicalApiHandler = createCanonicalApiHandler({
  pool,
  appOrigin: process.env.APP_ORIGIN,
  mergeReviewToken: process.env.MERGE_REVIEW_TOKEN,
  env: process.env,
  production: IS_PROD
});
const feedbackIssuesApiHandler = createFeedbackIssuesApiHandler({
  pool,
  appOrigin: process.env.APP_ORIGIN,
  production: IS_PROD
});

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-api-key, x-merge-review-token, Idempotency-Key');
}

function serveStatic(res, filePath) {
  const full = path.join(__dirname, 'build', filePath);
  const target = fs.existsSync(full) ? full : path.join(__dirname, 'build', 'index.html');
  const ext = path.extname(target);
  const mime = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
  }[ext] || 'text/plain';
  try {
    const content = fs.readFileSync(target);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (await canonicalApiHandler(req, res)) return;
  if (await feedbackIssuesApiHandler(req, res)) return;
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // ── Shared data (Heroku Postgres) ───────────────────────────
  if (pathname === '/api/data') {
    if (req.method === 'GET') {
      if (!pool) { res.writeHead(503); res.end(JSON.stringify({ error: 'No database configured' })); return; }
      try {
        const result = await pool.query("SELECT payload FROM app_data WHERE id = 'main'");
        const payload = result.rows[0]?.payload || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.method === 'POST') {
      res.removeHeader('Access-Control-Allow-Origin');
      if (!pool) { res.writeHead(503); res.end(JSON.stringify({ error: 'No database configured' })); return; }
      let body = ''; let size = 0; let tooLarge = false;
      req.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) tooLarge = true; else body += chunk; });
      req.on('end', async () => {
        try {
          if (tooLarge) { const error = new Error('Request body is too large'); error.status = 413; throw error; }
          const data = JSON.parse(body);
            validateAppDataWrite(data, req.headers, process.env.APP_ORIGIN, size, { production: IS_PROD });
            res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
            const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query("SET LOCAL lock_timeout = '5s'");
            await client.query("SET LOCAL statement_timeout = '15s'");
            await client.query('SELECT pg_advisory_xact_lock($1)', [CUTOVER_LOCK_ID]);
            const cutover = await readCutoverState(client);
            if (cutover.stage === 'canonical_active' &&
              (Object.prototype.hasOwnProperty.call(data, 'feedback') || Object.prototype.hasOwnProperty.call(data, 'closedLoop'))) {
              const error = new Error('Canonical Field Inputs cannot be written through /api/data'); error.status = 409; throw error;
            }
            const current = await client.query("SELECT payload FROM app_data WHERE id = 'main' FOR UPDATE");
            const approved = mergeApprovedSidecars(current.rows[0]?.payload || {}, data);
            await client.query("INSERT INTO app_data (id, payload, updated_at) VALUES ('main', $1, NOW()) ON CONFLICT (id) DO UPDATE SET payload = $1, updated_at = NOW()", [approved]);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally { client.release(); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.status ? e.message : 'Internal server error' }));
        }
      });
      return;
    }
  }

  // ── AI feedback-dedup cache (Heroku Postgres, separate table) ─
  if (pathname === '/api/dedup-cache') {
    if (!pool) { res.writeHead(503); res.end(JSON.stringify({ error: 'No database configured' })); return; }
    if (req.method === 'GET') {
      const initiativeId = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('initiativeId');
      if (!initiativeId) { res.writeHead(400); res.end(JSON.stringify({ error: 'initiativeId is required' })); return; }
      try {
        const result = await pool.query('SELECT payload FROM dedup_cache WHERE initiative_id = $1', [initiativeId]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.rows[0]?.payload || null));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { initiativeId, payload } = JSON.parse(body);
          if (!initiativeId) throw new Error('initiativeId is required');
          await pool.query(
            'INSERT INTO dedup_cache (initiative_id, payload, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (initiative_id) DO UPDATE SET payload = $2, updated_at = NOW()',
            [initiativeId, payload]
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  // ── Live Jira sync — pulls every ticket in the project straight from Jira ──
  if (pathname === '/api/jira-sync') {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN || (!JIRA_PROJECT_KEY && !JIRA_BOARD_ID)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Jira is not configured on the server (need JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, and either JIRA_BOARD_ID or JIRA_PROJECT_KEY).' }));
      return;
    }
    try {
      const issues = JIRA_BOARD_ID ? await fetchAllBoardIssues(JIRA_BOARD_ID) : await fetchAllJiraIssues();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ issues, syncedAt: new Date().toISOString() }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Create a Jira story directly from an unmatched feedback group ──
  if (pathname === '/api/jira-create') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_PROJECT_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Jira story creation requires JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, and JIRA_PROJECT_KEY to be configured on the server.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { summary, description, priority, assigneeEmail } = JSON.parse(body);
        if (!summary) throw new Error('summary is required');
        const trimmedSummary = summary.slice(0, 250);

        // Best-effort — an assignee the human picked is a nice-to-have, not a reason to fail
        // the whole ticket creation if Jira's user search doesn't recognize the address.
        let assignee = null;
        let assigneeWarning = null;
        if (assigneeEmail) {
          try {
            const searchRes = await fetch(`${JIRA_BASE_URL}/rest/api/3/user/search?query=${encodeURIComponent(assigneeEmail)}`, {
              headers: { Authorization: jiraAuthHeader() }
            });
            const matches = searchRes.ok ? await searchRes.json() : [];
            if (matches[0]?.accountId) assignee = { accountId: matches[0].accountId, displayName: matches[0].displayName };
            else assigneeWarning = `Created but couldn't find a Jira user matching ${assigneeEmail} — left unassigned.`;
          } catch {
            assigneeWarning = `Created but the Jira user lookup for ${assigneeEmail} failed — left unassigned.`;
          }
        }

        const createRes = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
          method: 'POST',
          headers: { Authorization: jiraAuthHeader(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              project: { key: JIRA_PROJECT_KEY },
              summary: trimmedSummary,
              issuetype: { name: 'Story' },
              description: textToADF(description || ''),
              // Optional — omitted entirely rather than defaulted, since an unrecognized priority
              // name is a hard 400 from Jira and projects don't all share the same priority scheme.
              ...(priority ? { priority: { name: priority } } : {}),
              ...(assignee ? { assignee: { accountId: assignee.accountId } } : {}),
              ...(JIRA_EPIC_KEY ? { [JIRA_EPIC_LINK_FIELD]: JIRA_EPIC_KEY } : {})
            }
          })
        });
        const createJson = await createRes.json();
        if (!createRes.ok) {
          const msg = (createJson.errorMessages && createJson.errorMessages.join('; '))
            || (createJson.errors && JSON.stringify(createJson.errors))
            || `Jira create failed: ${createRes.status}`;
          throw new Error(msg);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          key: createJson.key,
          url: `${JIRA_BASE_URL}/browse/${createJson.key}`,
          assignee: assignee ? assignee.displayName : null,
          assigneeWarning,
          issue: {
            key: createJson.key, summary: trimmedSummary, status: 'To Do', statusCategory: 'new',
            issueType: 'Story', parentKey: JIRA_EPIC_KEY, parentSummary: JIRA_EPIC_KEY ? 'CoE Feedback Tracker — Auto-Created Tickets' : '',
            sprint: '', sprintState: '', release: '', labels: [], priority: priority || '', fixVersion: '',
            description: description || '', updated: new Date().toISOString()
          }
        }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Slack: DM the OU/CoE advisor who owns a region (needs their intervention to act on it) ──
  if (pathname === '/api/slack/notify-advisor') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (!SLACK_BOT_TOKEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Slack is not configured on the server (need SLACK_BOT_TOKEN).' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { email, message } = JSON.parse(body);
        if (!email || !message) throw new Error('email and message are required');
        const lookup = await slackGet('users.lookupByEmail', { email });
        await slackPost('chat.postMessage', { channel: lookup.user.id, text: message });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, user: lookup.user.real_name || lookup.user.name }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Slack: post a broader-audience status update to a shared channel ─────────────────────
  if (pathname === '/api/slack/notify-channel') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (!SLACK_BOT_TOKEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Slack is not configured on the server (need SLACK_BOT_TOKEN).' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { channel, message } = JSON.parse(body);
        if (!channel || !message) throw new Error('channel and message are required');
        await slackPost('chat.postMessage', { channel: channel.startsWith('#') ? channel : `#${channel}`, text: message });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Serve React build in production ─────────────────────────
  if (IS_PROD) {
    if (pathname.startsWith('/static/') || pathname.includes('.')) {
      serveStatic(res, pathname);
    } else {
      serveStatic(res, 'index.html');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT} (${IS_PROD ? 'production' : 'development'})`);
});
