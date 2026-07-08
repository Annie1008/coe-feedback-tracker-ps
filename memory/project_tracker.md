---
name: project-tracker
description: React app tracking CoE Initiatives and field feedback — current state and what's left
metadata:
  type: project
---

App is a React 18 web app (create-react-app) with a Node.js proxy server (server.js).

**Live Heroku URL:** https://coe-feedback-tracker-ccaf5d22d612.herokuapp.com/
**Heroku app name:** coe-feedback-tracker
**Git remote:** https://git.heroku.com/coe-feedback-tracker.git

**Local dev:** `npm start` in `/Users/megan.madden/claude/CoE Initiative Feedback Tracker`

**Data storage:** localStorage (per-browser — not shared between users yet)
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
- Heroku deployment configured (Procfile, server.js serves build in prod)

**What's next:**
- Complete Heroku deploy (currently mid-deploy — pushing code)
- Shared data via Firebase (each user currently sees own localStorage data)
- Git Soma for code storage (optional)
