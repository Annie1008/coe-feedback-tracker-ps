const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createPool } = require('./server/db');

const PORT = process.env.PORT || 3001;
const IS_PROD = process.env.NODE_ENV === 'production';
const AI_BASE_URL = 'https://eng-ai-model-gateway.sfproxy.devx-preprod.aws-esvc1-useast2.aws.sfdc.cl';
// Dedicated key for the Feedback Analyzer's automatic AI dedup — kept server-side only (never
// shipped to the browser) so that feature works for everyone without each person entering their
// own personal gateway key. Falls back to a per-user key if the client sends one.
const FEEDBACK_ANALYZER_AI_KEY = process.env.FEEDBACK_ANALYZER_AI_KEY || '';

// Live Jira connection — kept server-side only, same reasoning as the AI key above: the token
// never reaches the browser, so the sync feature just works for everyone against one shared
// Jira account rather than requiring each person's own token.
const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || '';
// The specific backlog board the team actually plans against (e.g. https://.../boards/435/backlog).
// Scoping to this board instead of the whole project matters: the project has 1400+ Stories/Epics
// going back years, most of them unrelated to this initiative, and matching feedback against that
// whole pile produced false positives (generic-word overlap with irrelevant old tickets). The board
// is exactly the set of sprints + backlog the team is planning past/present/future work against.
const JIRA_BOARD_ID = process.env.JIRA_BOARD_ID || '';

function jiraAuthHeader() {
  return 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
}

async function jiraGet(urlPath) {
  const res = await fetch(`${JIRA_BASE_URL}${urlPath}`, { headers: { Authorization: jiraAuthHeader() } });
  if (!res.ok) throw new Error(`Jira request failed: ${res.status} ${await res.text()} (${urlPath})`);
  return res.json();
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

function normalizeBoardIssue(issue, sprint) {
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
    description: adfToText(issue.fields.description).replace(/\s+/g, ' ').trim(),
    updated: issue.fields.updated || ''
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

// Mirrors what the backlog board is actually being planned against: every issue in the board's
// currently active sprint and its future/not-yet-started sprints, plus everything still sitting
// in the unscheduled backlog bucket. Deliberately excludes closed sprints — this board's history
// goes back to 2023 (90+ closed sprints, thousands of issues from long-shipped, unrelated work),
// and pulling all of it is exactly what produced false-positive feedback matches earlier. Verified
// against board 435: filtering to non-closed sprints yields precisely the set of upcoming/current
// release sprints the team plans against, with nothing extra and nothing missing.
async function fetchAllBoardIssues(boardId) {
  const fields = 'summary,status,issuetype,parent,description,updated,labels';
  const byKey = new Map();

  const allSprints = await fetchBoardSprints(boardId);
  const sprints = allSprints.filter(s => s.state !== 'closed');
  for (const sprint of sprints) {
    let startAt = 0;
    for (;;) {
      const page = await jiraGet(`/rest/agile/1.0/board/${boardId}/sprint/${sprint.id}/issue?maxResults=100&startAt=${startAt}&fields=${fields}`);
      (page.issues || []).forEach(issue => byKey.set(issue.key, normalizeBoardIssue(issue, sprint)));
      if (!page.issues || page.issues.length === 0 || startAt + page.issues.length >= page.total) break;
      startAt += page.issues.length;
    }
  }

  let startAt = 0;
  for (;;) {
    const page = await jiraGet(`/rest/agile/1.0/board/${boardId}/backlog?maxResults=100&startAt=${startAt}&fields=${fields}`);
    (page.issues || []).forEach(issue => byKey.set(issue.key, normalizeBoardIssue(issue, null)));
    if (!page.issues || page.issues.length === 0 || startAt + page.issues.length >= page.total) break;
    startAt += page.issues.length;
  }

  return Array.from(byKey.values());
}

// Pulls every Story and Epic in the configured project, paginating through the whole backlog —
// past (closed sprints/Done), present (active sprint), and future (future sprints/no sprint yet)
// — so feedback can be matched against the full set of storylines, not just what's currently
// visible on one board view. Fallback for when no specific board is configured.
async function fetchAllJiraIssues() {
  const sprintFieldId = await getSprintFieldId();
  const fields = ['summary', 'status', 'issuetype', 'parent', 'description', 'updated', sprintFieldId];
  const issues = [];
  let nextPageToken;
  for (;;) {
    const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: jiraAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql: `project = ${JIRA_PROJECT_KEY} AND issuetype in (Story, Epic) ORDER BY updated DESC`,
        maxResults: 100,
        nextPageToken,
        fields
      })
    });
    if (!res.ok) throw new Error(`Jira search failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    (page.issues || []).forEach(issue => {
      const sprint = pickRelevantSprint(issue.fields[sprintFieldId]);
      issues.push({
        key: issue.key,
        summary: issue.fields.summary || '',
        status: issue.fields.status?.name || '',
        statusCategory: issue.fields.status?.statusCategory?.key || '',
        issueType: issue.fields.issuetype?.name || '',
        parentKey: issue.fields.parent?.key || '',
        parentSummary: issue.fields.parent?.fields?.summary || '',
        sprint: sprint?.name || '',
        sprintState: sprint?.state || '',
        description: adfToText(issue.fields.description).replace(/\s+/g, ' ').trim(),
        updated: issue.fields.updated || ''
      });
    });
    if (page.isLast || !page.issues || page.issues.length === 0 || !page.nextPageToken) break;
    nextPageToken = page.nextPageToken;
  }
  return issues;
}

// Heroku Postgres schema is applied by the release-phase migration command.
const pool = createPool();

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-api-key');
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
      if (!pool) { res.writeHead(503); res.end(JSON.stringify({ error: 'No database configured' })); return; }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          await pool.query(
            "INSERT INTO app_data (id, payload, updated_at) VALUES ('main', $1, NOW()) ON CONFLICT (id) DO UPDATE SET payload = $1, updated_at = NOW()",
            [data]
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

  // ── Live Jira sync — pulls Stories/Epics straight from Jira ──
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
        const { summary, description } = JSON.parse(body);
        if (!summary) throw new Error('summary is required');
        const trimmedSummary = summary.slice(0, 250);
        const createRes = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
          method: 'POST',
          headers: { Authorization: jiraAuthHeader(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              project: { key: JIRA_PROJECT_KEY },
              summary: trimmedSummary,
              issuetype: { name: 'Story' },
              description: textToADF(description || '')
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
          issue: {
            key: createJson.key, summary: trimmedSummary, status: 'To Do', statusCategory: 'new',
            issueType: 'Story', parentKey: '', parentSummary: '', sprint: '', sprintState: '',
            release: '', labels: [], description: description || '', updated: new Date().toISOString()
          }
        }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── AI proxy — forwards user's own key to the gateway ───────
  if (pathname === '/api/ai') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const userKey = req.headers['x-user-api-key'] || FEEDBACK_ANALYZER_AI_KEY;
      if (!userKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No API key provided and no FEEDBACK_ANALYZER_AI_KEY configured on the server.' }));
        return;
      }

      const target = new URL('/v1/messages', AI_BASE_URL);
      const options = {
        hostname: target.hostname,
        path: target.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': userKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const proxyReq = https.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', err => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error: ' + err.message }));
      });
      proxyReq.write(body);
      proxyReq.end();
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
