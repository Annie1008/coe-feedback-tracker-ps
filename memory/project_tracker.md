---
name: project-tracker
description: React app tracking CoE Initiatives and field feedback — current state and what's left
metadata:
  type: project
---

App is a React 18 web app (create-react-app) with a Node.js proxy server (server.js).

**Live Heroku URL:** https://coe-feedback-tracker-ps-ec31af261cda.herokuapp.com/
**Heroku app name:** coe-feedback-tracker-ps
**Git remote:** https://git.heroku.com/coe-feedback-tracker-ps.git

**Local dev:** `npm start` in `/Users/megan.madden/claude/CoE Initiative Feedback Tracker`

**Data storage:** Postgres canonical Field Inputs (cutover still `legacy_read_only` until activate)
**AI:** Bring-your-own Salesforce LLM Gateway Express key, stored in browser localStorage, proxied through server.js

**Why:** Internal tool for Salesforce Global PS Scoping CoE to track initiatives, field feedback, OU enablement, and run AI synthesis.

**What's done:**
- Initiatives CRUD with OU enablement tracking
- Feedback logging with AI document upload parsing
- Edit/delete feedback, action items, closed loop tracking
- AI query box on home + initiative pages
- AI Synthesis panel (friction map, exec summary, etc.)
- Dashboard with donut chart, OU heatmap, enablement matrix
- Bring-your-own key model (🔑 button in header)
- Canonical Field Inputs schema, two-stage cutover, Slack/Jira sidecars

**What's next:**
- Deploy operator repair (`npm run cutover:repair-pre`) then `npm run cutover:activate`
- Confirm `/api/canonical/cutover-state` is `canonical_active`
