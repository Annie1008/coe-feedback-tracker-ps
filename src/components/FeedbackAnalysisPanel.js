import React, { useMemo, useState, useEffect } from 'react';
import { matchRoadmap } from '../roadmapData';
import { callFeedbackAI } from '../apiKey';
import { loadDedupCache, saveDedupCache, monthKey, monthLabel } from '../data';
import JiraSyncPanel from './JiraSyncPanel';
import WordCloud from './WordCloud';

// Words/phrases that flip the sentiment of whatever follows within a couple of words
// (e.g. "no issues", "not great") — without this, negated praise/complaints misclassify.
const NEGATIONS = ['no', 'not', "don't", 'dont', "doesn't", 'doesnt', "didn't", 'didnt', 'without', 'never'];

const NEGATIVE_WORDS = [
  'issue', 'issues', 'problem', 'problems', 'bug', 'bugs', 'broken', 'fail', 'failed', 'fails',
  'error', 'errors', 'slow', 'slowly', 'confusing', 'confused', 'unclear', 'difficult', 'unable',
  'cannot', 'cant', "can't", 'missing', 'lacking', 'lacks', 'lack', 'needed', 'needs', 'need',
  'limitation', 'limitations', 'limited', 'gap', 'gaps', 'friction', 'workaround', 'workarounds',
  'blocker', 'blocked', 'stuck', 'wish', 'improve', 'improvement', 'improvements', 'suggest',
  'suggestion', 'suggestions', 'concern', 'concerns', 'risk', 'risks', 'delay', 'delayed', 'crash',
  'crashes', 'crashed', 'incorrect', 'wrong', 'inconsistent', 'inconsistency', 'timeout', 'timedout',
  'frustrating', 'frustrated', 'annoying', 'poor', 'harder', 'request', 'requesting'
];

const NEGATIVE_PHRASES = [
  'time consuming', 'timed out', 'not working', 'not intuitive', 'not user friendly',
  'too long', 'took too long', 'should be', 'should have', 'should include',
  'would be nice', 'instead of', 'unable to', 'ability to', 'needs to', 'need to'
];

const POSITIVE_WORDS = [
  'great', 'love', 'loved', 'loves', 'excellent', 'amazing', 'fantastic', 'awesome', 'impressed',
  'impressive', 'helpful', 'useful', 'easy', 'efficient', 'smooth', 'nice', 'perfect', 'positive',
  'happy', 'satisfied', 'appreciate', 'appreciated', 'valuable', 'praise', 'good', 'best', 'wonderful',
  'outstanding'
];

const POSITIVE_PHRASES = [
  'works well', 'working well', 'good experience', 'well done', 'saves time', 'time saver',
  'exceeded expectations', 'thank you', 'no issues', 'no problems', 'no complaints', 'no concerns'
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'was', 'be', 'it', 'this',
  'that', 'with', 'as', 'are', 'i', 'we', 'they', 'he', 'she', 'have', 'has', 'had', 'at', 'by',
  'from', 'into', 'about', 'so', 'but', 'if', 'than', 'then', 'there', 'when', 'which', 'who',
  'what', 'can', 'could', 'would', 'should', 'will', 'been', 'being', 'do', 'does', 'did', 'not',
  // Domain-wide filler words that show up in nearly every entry — they carry no discriminative
  // signal for "do these two mean the same thing" (everything mentions the tool/app/system),
  // so they're treated as noise for similarity, same as ordinary stopwords.
  'tool', 'app', 'application', 'system', 'platform', 'solutioniq', 'product', 'feature',
  'features', 'area', 'section', 'currently', 'also', 'like', 'get', 'gets', 'getting'
]);

// Canonicalizes near-synonyms that express the *same underlying complaint or request* in
// different words (e.g. "confusing" / "unclear", "missing" / "lacking"), so paraphrased
// feedback collapses onto shared tokens instead of missing each other on raw string overlap.
const SYNONYM_GROUPS = [
  ['issue', 'issues', 'problem', 'problems', 'bug', 'bugs', 'error', 'errors', 'glitch', 'glitches', 'broken'],
  ['slow', 'slowly', 'slower', 'lag', 'lags', 'laggy', 'sluggish', 'delay', 'delayed', 'delays', 'timeout', 'timedout', 'wait', 'waiting', 'waited'],
  ['confusing', 'confused', 'unclear', 'ambiguous', 'vague', 'confusion'],
  ['missing', 'lacking', 'lacks', 'lack', 'absent', 'unavailable'],
  ['need', 'needs', 'needed', 'require', 'requires', 'required', 'want', 'wants', 'wanted', 'wish', 'request', 'requesting', 'requested', 'ability', 'able', 'capability', 'capable'],
  ['add', 'include', 'including', 'adding', 'incorporate', 'incorporating'],
  ['view', 'viewing', 'display', 'displaying', 'displayed', 'shown', 'show', 'showing', 'visibility', 'visible'],
  ['field', 'fields', 'column', 'columns', 'attribute', 'attributes'],
  ['export', 'exporting', 'download', 'downloading', 'downloadable'],
  ['screen', 'page', 'pages', 'tab', 'tabs', 'panel', 'panels'],
  ['click', 'clicking', 'clicked', 'select', 'selecting', 'selected', 'selection'],
  ['flexible', 'flexibility', 'customizable', 'customize', 'customization', 'editable', 'edit', 'editing']
];
const SYNONYM_MAP = new Map();
SYNONYM_GROUPS.forEach(group => { const canon = group[0]; group.forEach(w => SYNONYM_MAP.set(w, canon)); });

// Light suffix stemmer so plain plural/tense variants ("issues" vs "issue", "generated" vs
// "generate") land on the same token — deliberately conservative to avoid inventing false
// equivalences between unrelated words.
function stem(word) {
  if (word.length > 4 && /ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (word.length > 5 && /ing$/.test(word)) return word.slice(0, -3);
  if (word.length > 4 && /ed$/.test(word) && !/eed$/.test(word)) return word.slice(0, -2);
  if (word.length > 4 && /es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && /s$/.test(word) && !/ss$/.test(word) && !/us$/.test(word)) return word.slice(0, -1);
  return word;
}

function canonicalize(word) {
  if (SYNONYM_MAP.has(word)) return SYNONYM_MAP.get(word);
  const stemmed = stem(word);
  return SYNONYM_MAP.get(stemmed) || stemmed;
}

// Two-pass dedup: exact-normalized match first (catches copy/paste or repeated entries), then
// fuzzy meaning-overlap for short-enough token sets — short entries are too noisy to fuzzy-match
// reliably. Threshold/window were tuned against 432 real SolutionIQ feedback records: 0.45 caught
// 21 genuine paraphrase clusters (verified by hand) with zero false merges; going lower (0.35)
// started merging distinct items that just share a complaint pattern (e.g. two different sections
// both described as "missing details" — same shape, different subject).
const JACCARD_THRESHOLD = 0.45;
const MIN_SHARED_TOKENS = 2;
const MIN_TOKENS_FOR_FUZZY = 3;

// Same insight as JIRA_GENERIC_WORDS below, applied to feedback-to-feedback matching: these are
// complaint/request *shape* words, not topic words — two unrelated entries that both say
// "missing", "confusing", "need" etc. can still clear the Jaccard threshold on shape alone (the
// exact false-positive class called out above — "missing details" on two different sections).
// Filtered out of the token set used for the *fuzzy* comparison only; exact-text matching and
// sentiment classification still see every word.
const FEEDBACK_GENERIC_WORDS = new Set([
  'issue', 'confusing', 'missing', 'need', 'improve', 'improvement', 'suggestion', 'concern',
  'risk', 'gap', 'limitation', 'blocker', 'workaround', 'friction', 'wrong', 'poor',
  'frustrating', 'annoying', 'difficult', 'unable', 'request', 'detail', 'details'
].map(canonicalize));

function combinedText(f) {
  return [f.frictionPoints, f.toolsMentioned, f.workarounds, f.dealImpact, f.quotes, f.notes]
    .filter(Boolean).join(' ');
}

function feedbackDetailText(f) {
  const parts = [];
  if (f.frictionPoints) parts.push(`Friction Points: ${f.frictionPoints}`);
  if (f.toolsMentioned) parts.push(`Tools Mentioned: ${f.toolsMentioned}`);
  if (f.workarounds) parts.push(`Workarounds: ${f.workarounds}`);
  if (f.dealImpact) parts.push(`Deal Impact: ${f.dealImpact}`);
  if (f.quotes) parts.push(`Quotes: ${f.quotes}`);
  if (f.notes) parts.push(`Notes: ${f.notes}`);
  return parts.join(' | ') || '(no details)';
}

// Bulk-upload entries are tagged "Feedback #3b - Landing Page (Archive Button): ..." —
// strip that categorization label before matching so duplicates tagged with different
// labels (or no label) still collapse into one group; the original text is still shown as-is.
const BULK_UPLOAD_PREFIX = /^feedback\s*#\d+[a-z]?\s*(\(part\s*[a-z]\))?\s*[-—–]\s*[^:]+:\s*/i;

function stripCategoryPrefix(text) {
  return text.replace(BULK_UPLOAD_PREFIX, '');
}

function normalize(text) {
  return stripCategoryPrefix(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(normalized) {
  return normalized.split(' ').filter(w => w && !STOPWORDS.has(w)).map(canonicalize);
}

function classifySentiment(rawText) {
  const normalized = normalize(rawText);
  const words = normalized.split(' ');
  let score = 0;

  words.forEach((word, idx) => {
    const precededByNegation = NEGATIONS.some(n => normalize(n) === words[idx - 1] || normalize(n) === words[idx - 2]);
    if (NEGATIVE_WORDS.includes(word)) score += precededByNegation ? 1 : -1;
    else if (POSITIVE_WORDS.includes(word)) score += precededByNegation ? -1 : 1;
  });

  NEGATIVE_PHRASES.forEach(p => { if (normalized.includes(p)) score -= 1; });
  POSITIVE_PHRASES.forEach(p => { if (normalized.includes(p)) score += 1; });

  // No detected signal either way — treat as Neutral rather than assuming it's a complaint;
  // plenty of entries are plain requests/questions/descriptions, not pain points.
  if (score > 0) return 'Positive';
  if (score < 0) return 'Negative';
  return 'Neutral';
}

// Collapses whatever the AI (or a stale/malformed cache entry) returned into one of the three
// sentiment values the rest of the app understands — anything unrecognized defaults to Neutral,
// not Negative, so a parsing hiccup doesn't silently inflate the complaint count.
function normalizeSentiment(raw) {
  return raw === 'Positive' || raw === 'Negative' || raw === 'Neutral' ? raw : 'Neutral';
}

// Which pod owns which part of the tool — used to route negative feedback to the right team.
// Keyword sets were tuned against real SolutionIQ feedback: broad enough to catch each pod's
// area, narrow enough to avoid false hits (e.g. plain "rate" as a substring of "generate").
const PODS = [
  {
    key: 'pod1', name: 'POD 1', focus: 'Scenario Lab / Certinia rebuild, Commercial Model',
    lead: 'Michelle Long', members: ['Bhavik Mayur Sanghvi', 'Vikas Gabhane', 'Saket Khandelwal'],
    keywords: ['scenario lab', 'certinia', 'commercial model', 'global component', 'reusable component', 'component library', 't&m', 'fixed fee', 'pricing stage', 'pricing type']
  },
  {
    key: 'pod2', name: 'POD 2', focus: 'Risk indicators, recommended-team logic, delivery model',
    lead: 'Erin Sherrell', members: ['Bharat Kumar', 'Shiva Patibandla', 'Joyce Thoppil'],
    keywords: ['risk indicator', 'sds', 'recommended team', 'recommended-team', 'delivery model', 'delivery-model', 'staffing model', 'team recommendation']
  },
  {
    key: 'pod3', name: 'POD 3', focus: 'Scope engine, Scope/Out-of-Scope/Assumptions UI',
    lead: 'Daniel Furry', members: ['Vaibhav Kumar', 'Deepak Kumar', 'Aisha Sohail', 'Ujjwal Grade'],
    keywords: ['scop', 'out of scope', 'out-of-scope', 'assumption', 'marketing cloud', 'confirmed scope', 'assumed scope']
  },
  {
    key: 'uiux', name: 'UI/UX', focus: 'Scenario Lab design alternatives, home page direction',
    lead: 'Mariella Volio', members: [],
    keywords: ['design', 'home page', 'homepage', 'landing page', 'layout', 'navigation', 'visual design', 'user interface', 'font', 'color', 'button placement', 'look and feel', 'floating menu', 'panel', 'screen space', 'scenario lab']
  }
];

// Email lookup for everyone assignable in the Pod Tracker, used to build mailto links —
// keyed by the exact name string used as pod.lead / pod.members entries above.
const PEOPLE_EMAILS = {
  'Aisha Sohail': 'a.sohail@salesforce.com',
  'Ashok Kumar Reddy Yerasi': 'ayerasi@salesforce.com',
  'Bharat Kumar': 'bharatkumar@salesforce.com',
  'Bhavik Mayur Sanghvi': 'bsanghvi@salesforce.com',
  'Daniel Furry': 'daniel.furry@salesforce.com',
  'Deepak Kumar': 'dkumar7@salesforce.com',
  'Erin Sherrell': 'esherrell@salesforce.com',
  'Indrashis Ghosh': 'indrashis.ghosh@salesforce.com',
  'Joyce Thoppil': 'joyce.joseph@salesforce.com',
  'Katherine King': 'katherineking@salesforce.com',
  'Vaibhav Kumar': 'kumarvaibhav@salesforce.com',
  'Michelle Long': 'michelle.long@salesforce.com',
  'Mariella Volio': 'mvolio@salesforce.com',
  'Rakesh Rajput': 'rakesh.rajput@salesforce.com',
  'Roderick Thornton': 'roderick.thornton@salesforce.com',
  'Shiva Patibandla': 's.patibandla@salesforce.com',
  'Saket Khandelwal': 'saket.khandelwal@salesforce.com',
  'Ananya Singh': 'singhananya@salesforce.com',
  'Ujjwal Grade': 'ugrade@salesforce.com',
  'Vikas Gabhane': 'vgabhane@salesforce.com'
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordRegex(kw) {
  return new RegExp('\\b' + escapeRegExp(kw).replace(/\\ /g, '\\s+') + '\\w*\\b', 'i');
}

PODS.forEach(pod => { pod.regexes = pod.keywords.map(keywordRegex); });

// Scores each pod by keyword-hit count and returns whichever pod(s) tie for the top score.
// Returns [] when nothing matches, so the caller can flag the feedback as needing manual triage
// instead of guessing at an owner with no real signal.
function routeToPod(rawText) {
  const stripped = stripCategoryPrefix(rawText);
  const scored = PODS.map(pod => ({ pod, score: pod.regexes.filter(re => re.test(stripped)).length }));
  const max = Math.max(...scored.map(s => s.score));
  if (max === 0) return [];
  return scored.filter(s => s.score === max).map(s => s.pod);
}

function jaccard(setA, setB) {
  let shared = 0;
  setA.forEach(w => { if (setB.has(w)) shared++; });
  const union = setA.size + setB.size - shared;
  return { ratio: union === 0 ? 0 : shared / union, shared };
}

// Jira ticket summaries are short ("Build sequencing - Data flows + Integrations") next to
// a whole feedback paragraph, so plain Jaccard (which penalizes size mismatch) would almost
// never clear a sane threshold. Instead this scores by *coverage* — what fraction of the
// ticket's own tokens show up somewhere in the feedback — so a short, specific ticket title
// fully contained in a long feedback entry still counts as a strong match.
const JIRA_MATCH_COVERAGE = 0.6;
const JIRA_MIN_SHARED_TOKENS = 2;

// Words that are near-universal filler across both Jira story titles and feedback text —
// "ability to select an option", "need to add a view", etc. Left in STOPWORDS/SYNONYM_MAP
// they're fine for feedback-to-feedback dedup (that path needs plenty of shared tokens to
// clear a Jaccard threshold, so a few generic ones don't decide the outcome alone). But a
// short Jira title can consist of *mostly* these words plus one or two real nouns, and the
// coverage check only needs 60% of the title's tokens to hit — so two completely unrelated
// texts that both happen to say "ability", "select", "option" and "all" can clear that bar
// without ever sharing the actual topic (verified against a real false-positive match: a
// feedback item about missing industries in a dropdown matched a ticket about a "Not
// Applicable" option on Questions purely on those four words). Stripped only for Jira
// matching, on both sides, so a match must be carried by content words instead.
const JIRA_GENERIC_WORDS = new Set([
  'ability', 'able', 'need', 'needs', 'option', 'options', 'select', 'selected', 'selecting',
  'click', 'clicking', 'clicked', 'all', 'add', 'adding', 'view', 'viewing'
]);

function jiraTokenize(normalized) {
  return tokenize(normalized).filter(t => !JIRA_GENERIC_WORDS.has(t));
}

// Deliberately title-only. An earlier version also scored the ticket's full description
// (its "As a X, I want Y, so that Z" user story + BRD/release-notes boilerplate) by raw
// shared-token count, but that boilerplate is near-identical across every ticket — it matched
// 293 of 428 real feedback groups (68%) against the actual SEPSP export, vs 9 (2%) for
// title-only, and spot-checking those 9 showed genuine topical overlap. Descriptions are too
// long and too repetitive in structure to score reliably without much heavier NLP.
function matchJiraIssue(rawText, jiraIssues) {
  if (!rawText || !jiraIssues || jiraIssues.length === 0) return null;
  const feedbackTokens = new Set(jiraTokenize(normalize(rawText)));
  let best = null;
  // Epics are broad umbrella titles ("UX Design System & Progressive Disclosure") — matching
  // feedback text against them directly produces false positives across many unrelated items.
  // Only match against the concrete Story tickets; a matched Story still carries its parent
  // Epic's name (parentSummary) for broader context.
  jiraIssues.filter(issue => issue.issueType !== 'Epic').forEach(issue => {
    const titleTokens = new Set(jiraTokenize(normalize(issue.summary)));
    if (titleTokens.size < JIRA_MIN_SHARED_TOKENS) return;
    let shared = 0;
    titleTokens.forEach(t => { if (feedbackTokens.has(t)) shared++; });
    const coverage = shared / titleTokens.size;
    if (coverage >= JIRA_MATCH_COVERAGE && shared >= JIRA_MIN_SHARED_TOKENS) {
      if (!best || coverage > best.coverage) best = { issue, coverage };
    }
  });
  return best ? best.issue : null;
}

// Shared by both the local matcher and the AI matcher below — turns a cluster of feedback
// items (already decided to be "the same point") into the group shape every tab consumes.
// `sentimentFn` lets the AI path use its own per-item sentiment read (it has real context —
// sarcasm, negation across a whole sentence) instead of the local keyword heuristic.
function buildGroup(members, sentimentFn) {
  // Representative text: the longest original entry in the group (most descriptive)
  const rep = members.reduce((best, cur) => cur.text.length > best.text.length ? cur : best, members[0]);
  const getSentiment = sentimentFn || (m => classifySentiment(m.text));
  const sentiments = members.map(getSentiment);
  // Plurality vote across the group's members — three-way now (Positive/Negative/Neutral),
  // so a group is whichever read most of its members actually got, not a >50% majority.
  const counts = { Positive: 0, Negative: 0, Neutral: 0 };
  sentiments.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
  const sentiment = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const sourceIds = members.map(m => m.f.id);
  // Most recent collection date among the group's members — used to tag the group with
  // the month it was (most recently) received, so older vs newer clusters are distinguishable.
  const latestDate = members.reduce((max, m) => {
    const d = m.f.date;
    return d && (!max || d > max) ? d : max;
  }, null);
  return {
    // Stable key for this cluster so a status note survives re-render/re-dedup as long
    // as the same set of underlying feedback IDs groups together.
    groupKey: sourceIds.slice().sort().join(','),
    summary: rep.text || '(no details)',
    sentiment,
    sourceIds,
    latestDate,
    // Both complaints and suggestions/requests are actionable for a pod to triage — only
    // pure praise (Positive) has nothing for a pod to act on.
    pods: sentiment !== 'Positive' ? routeToPod(rep.text) : []
  };
}

function dedupeFeedback(feedback) {
  const items = feedback.map(f => {
    const text = combinedText(f) || f.providerName || '';
    const norm = normalize(text);
    const tokens = new Set(tokenize(norm));
    const fuzzyTokens = new Set(Array.from(tokens).filter(t => !FEEDBACK_GENERIC_WORDS.has(t)));
    return { f, text, norm, tokens, fuzzyTokens };
  });

  const groups = []; // { normKey, tokens, fuzzyTokens, members: [item] }

  items.forEach(item => {
    // Pass 1: exact match on normalized text
    const exact = groups.find(g => g.normKey === item.norm);
    if (exact) { exact.members.push(item); return; }

    // Pass 2: fuzzy word-overlap match, only for longer entries — joins the BEST-scoring
    // candidate group above threshold, not just the first one encountered, so an item doesn't
    // settle for a mediocre earlier match when a later group is actually a closer fit.
    if (item.tokens.size >= MIN_TOKENS_FOR_FUZZY && item.fuzzyTokens.size > 0) {
      let best = null;
      groups.forEach(g => {
        if (g.tokens.size < MIN_TOKENS_FOR_FUZZY || g.fuzzyTokens.size === 0) return;
        const { ratio, shared } = jaccard(item.fuzzyTokens, g.fuzzyTokens);
        if (ratio >= JACCARD_THRESHOLD && shared >= MIN_SHARED_TOKENS && (!best || ratio > best.ratio)) {
          best = { group: g, ratio };
        }
      });
      if (best) { best.group.members.push(item); return; }
    }

    groups.push({ normKey: item.norm, tokens: item.tokens, fuzzyTokens: item.fuzzyTokens, members: [item] });
  });

  return groups.map(g => buildGroup(g.members)).sort((a, b) => b.sourceIds.length - a.sourceIds.length);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Runs `worker` over `items` with at most `limit` in flight at once — plain requests, no
// external queue library needed for a handful of batches.
async function runWithConcurrency(items, worker, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function stripJsonFences(text) {
  return text.trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
}

// On a large clustering task the model sometimes visibly second-guesses itself: it writes one
// JSON array, then a line like "Hmm, that has issues, let me redo this" followed by a second,
// corrected array. Taking the *first* complete JSON value in that case silently picks the
// answer the model itself just said was wrong. So this collects every complete top-level
// [...]/{...} value in the text (tracking bracket depth, respecting string literals, skipping
// anything that doesn't parse) and returns the LAST one — the model's final, corrected answer,
// which is also what you want in the ordinary case (markdown fences / trailing notes) since
// there's only one candidate then anyway.
function extractFinalJsonValue(text) {
  const trimmed = stripJsonFences(text);
  const candidates = [];
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch !== '[' && ch !== '{') { i++; continue; }
    const openChar = ch;
    const closeChar = openChar === '[' ? ']' : '}';
    let depth = 0, inString = false, escape = false, j = i;
    for (; j < trimmed.length; j++) {
      const c = trimmed[j];
      if (inString) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === openChar) depth++;
      else if (c === closeChar) {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break; // unterminated — nothing more to find after this
    try { candidates.push(JSON.parse(trimmed.slice(i, j + 1))); } catch { /* not real JSON, skip */ }
    i = j + 1;
  }
  if (candidates.length === 0) throw new Error('No valid JSON found in AI response');
  return candidates[candidates.length - 1];
}

// Retries a flaky AI+parse step once before giving up — covers one-off malformed responses
// without paying the retry cost on every call.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    return await fn();
  }
}

// Small batches so each request stays reliable (a 400+ entry prompt risks truncated/garbled
// JSON on the way back) — run several batches concurrently so total latency stays reasonable.
const EXTRACT_BATCH_SIZE = 30;
const EXTRACT_CONCURRENCY = 4;

// Stage 1 of AI dedup: read every entry *on its own*, in small parallel batches, and pull out
// its core meaning as a short normalized sentence (names/dates/numbers stripped) plus a
// sentiment read that has actual sentence context (unlike the local keyword heuristic). This
// turns hundreds of long, differently-worded entries into short, already-normalized strings —
// so the clustering stage below is comparing near-identical phrasing instead of raw prose.
async function extractMeanings(items) {
  const batches = chunk(items, EXTRACT_BATCH_SIZE);
  const batchResults = await runWithConcurrency(batches, async (batch) => {
    const listing = batch.map(it => `${it.idx}: ${it.text}`).join('\n---\n');
    const prompt = `For each feedback entry below (prefixed by its index), extract its core underlying point as a short, generic, normalized sentence (at most 15 words, no names/dates/numbers — just the issue, request, or observation itself) and classify its sentiment. Use consistent, canonical phrasing — if two entries describe the exact same issue, their extracted sentences should come out worded identically (same verb, same structure), not just similar.

Sentiment is one of three values — pick based on what the entry actually IS, not just its topic:
- "Negative": a genuine complaint, bug, pain point, blocker, or something broken/frustrating/not working.
- "Positive": praise, or an observation that something works well / is good / is liked.
- "Neutral": a plain feature request, suggestion, open question, or purely descriptive/informational statement — it isn't itself expressing a problem or praise, even if it implies something could be added or improved later.

Respond with ONLY a JSON array of objects, one per entry, same indices as given: [{"idx": <number>, "meaning": "<short normalized sentence>", "sentiment": "Positive" or "Negative" or "Neutral"}]. No explanation, no markdown code fences.

${listing}`;
    return withRetry(async () => {
      const response = await callFeedbackAI(prompt, 4096);
      const parsed = extractFinalJsonValue(response);
      return Array.isArray(parsed) ? parsed : [];
    });
  }, EXTRACT_CONCURRENCY);
  return batchResults.flat();
}

// Stage 2 of AI dedup: cluster the short normalized meanings from stage 1 — far fewer tokens
// than the raw entries, and already paraphrase-stripped, so grouping is both cheaper and more
// reliable than trying to read-and-cluster in one pass.
async function clusterMeanings(meanings) {
  const listing = meanings.map(m => `${m.idx}: ${m.meaning}`).join('\n');
  const prompt = `Below is a list of normalized feedback meanings, each prefixed by its index. Group indices whose meaning describes the same underlying point — the same issue, request, or observation — even when phrased slightly differently.

Use this test: two entries belong in the same group only if a single fix or answer would fully satisfy both of them. Do NOT group entries that just share a topic or general theme but would each need their own distinct fix — e.g. "notify me when a background task finishes" and "show a persistent progress indicator while it's running" are both about task visibility, but fixing one wouldn't address the other, so they're separate groups. Likewise "make the Product field a picklist" and "make the Role field a picklist" both ask for validation, but on different fields, so they're separate groups too.

Every index listed must appear in exactly one group. A meaning with nothing else like it is its own group of one.

Work through the grouping silently. Respond with ONLY the single final JSON array of arrays of indices — one inner array per group. Do not show a draft, do not explain your reasoning, do not say anything before or after it, and do not redo or restate it — output it exactly once.

${listing}`;
  return withRetry(async () => {
    const response = await callFeedbackAI(prompt, 8192);
    const parsed = extractFinalJsonValue(response);
    const idGroups = Array.isArray(parsed) ? parsed : parsed.groups;
    if (!Array.isArray(idGroups)) throw new Error('Unexpected AI response shape');
    return idGroups;
  });
}

// A single clustering pass over hundreds of meanings can still bundle several related-but-
// distinct asks under one shared theme (e.g. three different "make X visible to the user"
// requests that would each need their own fix). Groups at or above this size get one extra,
// cheap AI call — re-reading just that group's own members, with the same "same fix" test —
// to split out anything that doesn't actually belong. Small groups skip this: at this size a
// wrong 2-into-1 merge is easy to spot and fix by hand, not worth an extra call for every group.
const SPLIT_CHECK_MIN_SIZE = 6;
const SPLIT_CHECK_CONCURRENCY = 4;

async function splitMixedGroup(members) {
  const listing = members.map((m, i) => `${i}: ${m.text}`).join('\n---\n');
  const prompt = `These feedback entries were grouped together as describing the same underlying point. Double-check that: would a single fix or answer fully satisfy every entry below? If yes, keep them all in one group. If some would actually need their own distinct fix even though they share a topic, split those out into their own group(s).

Every index below must appear in exactly one output group.

Respond with ONLY a JSON array of arrays of indices — one inner array per final group. No explanation, no markdown fences.

${listing}`;
  return withRetry(async () => {
    const response = await callFeedbackAI(prompt, 2048);
    const parsed = extractFinalJsonValue(response);
    const idGroups = Array.isArray(parsed) ? parsed : parsed.groups;
    if (!Array.isArray(idGroups)) throw new Error('Unexpected AI response shape');
    return idGroups;
  });
}

// Collapses a meaning string to a comparison key — case/whitespace/punctuation-insensitive —
// so extracted meanings that are for-all-practical-purposes identical (the model was asked for
// canonical phrasing, but "no" vs "No" vs trailing period shouldn't matter) collapse together.
function normalizeMeaningKey(meaning) {
  return meaning.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Second-look merge pass over the FINAL groups, using one representative meaning per group.
// The main clustering call above compares every distinct meaning in a single pass, and once
// there are hundreds of them that one pass reliably misses real paraphrase duplicates that just
// land far apart in the list (verified against this app's real SolutionIQ data). One extra pass
// only closes part of that gap — re-running it against the *previous pass's own output* keeps
// finding a few more real merges each time (each pass shortens and reorders the representative
// list, exposing pairings the last pass's ordering hid), so repeat until a pass stops shrinking
// the count or the cap is hit, rather than assuming one pass is enough.
const MERGE_CHECK_MIN_GROUPS = 20;
const MERGE_CHECK_MAX_PASSES = 4;

async function mergeSimilarGroupsOnce(memberLists, meaningByIdx) {
  const reps = memberLists.map((members, idx) => ({
    idx, meaning: meaningByIdx.get(members[0].idx) || members[0].text
  }));
  let idGroups;
  try {
    idGroups = await clusterMeanings(reps);
  } catch {
    return memberLists; // bonus pass — a failure here just skips it, never breaks the base result
  }
  const seen = new Set();
  const merged = [];
  idGroups.filter(Array.isArray).forEach(groupIdxs => {
    const uniqueIdxs = Array.from(new Set(groupIdxs)).filter(i => memberLists[i] && !seen.has(i));
    if (uniqueIdxs.length === 0) return;
    uniqueIdxs.forEach(i => seen.add(i));
    merged.push(uniqueIdxs.flatMap(i => memberLists[i]));
  });
  memberLists.forEach((g, i) => { if (!seen.has(i)) merged.push(g); });
  return merged;
}

async function mergeSimilarGroups(memberLists, meaningByIdx) {
  let current = memberLists;
  for (let pass = 0; pass < MERGE_CHECK_MAX_PASSES && current.length >= MERGE_CHECK_MIN_GROUPS; pass++) {
    const next = await mergeSimilarGroupsOnce(current, meaningByIdx);
    if (next.length >= current.length) break; // converged — no further merges found
    current = next;
  }
  return current;
}

// AI-powered dedup, three stages: analyze every entry separately (extractMeanings), collapse
// exact-duplicate meanings deterministically (free, 100% reliable — no reason to make the AI
// re-discover that two identically-worded entries are the same point), then AI-cluster only
// the remaining *distinct* meanings to catch paraphrases worded differently. This keeps the
// clustering step's job smaller and more reliable than handing it every raw entry at once,
// which stops being trustworthy once there are hundreds of long, varied entries.
// Feedback is referenced by small integer index (not its real id) to keep prompts/responses
// compact — ids are long random strings and would burn output tokens just spelling them back.
// Returns both the final `groups` and a per-item `itemsMeta` map (meaning/sentiment/raw text
// keyed by feedback id) — the cached incremental path below uses `itemsMeta` to seed its cache
// with real extracted meanings instead of having to re-derive them later.
async function computeFullDedup(feedback) {
  const items = feedback.map((f, idx) => ({ idx, f, text: combinedText(f) || f.providerName || '(no details)' }));
  const byIdx = new Map(items.map(it => [it.idx, it]));

  const extracted = await extractMeanings(items);
  const meaningByIdx = new Map();
  const sentimentByIdx = new Map();
  extracted.forEach(e => {
    if (!e || typeof e.idx !== 'number' || !byIdx.has(e.idx)) return;
    if (e.meaning) meaningByIdx.set(e.idx, e.meaning);
    sentimentByIdx.set(e.idx, normalizeSentiment(e.sentiment));
  });

  // Deterministic pre-merge: bucket every item by its normalized meaning key. Two items whose
  // extraction came out identically worded are certainly the same point — no need to spend AI
  // clustering budget re-deciding that. Any entry the extraction step dropped or mistyped falls
  // back to its own raw text as the key, so it's never silently lost, just its own bucket.
  const keyToIdxs = new Map();
  items.forEach(it => {
    const meaning = meaningByIdx.get(it.idx) || it.text;
    const key = normalizeMeaningKey(meaning) || String(it.idx);
    if (!keyToIdxs.has(key)) keyToIdxs.set(key, { meaning, idxs: [] });
    keyToIdxs.get(key).idxs.push(it.idx);
  });
  const distinctKeys = Array.from(keyToIdxs.keys());

  // AI clustering now only has to compare `distinctKeys.length` meanings instead of
  // `items.length` raw entries — smaller prompt, smaller output, fewer chances to go wrong.
  const meaningsForClustering = distinctKeys.map((key, ci) => ({ idx: ci, meaning: keyToIdxs.get(key).meaning }));
  const idGroups = meaningsForClustering.length > 1 ? await clusterMeanings(meaningsForClustering) : [[0]];

  const sentimentFn = it => sentimentByIdx.get(it.idx) || classifySentiment(it.text);
  const seen = new Set();
  const rawGroups = [];
  idGroups.forEach(keyIdxList => {
    if (!Array.isArray(keyIdxList)) return;
    // De-dupe the group's own key-index list first — the model can repeat the same index
    // twice within one group, which the cross-group `seen` check below can't catch since
    // it only tracks indices added by *previous* groups, not repeats within this one.
    const originalIdxs = Array.from(new Set(keyIdxList.flatMap(ki => keyToIdxs.get(distinctKeys[ki])?.idxs || [])));
    const members = originalIdxs.map(i => byIdx.get(i)).filter(Boolean).filter(it => !seen.has(it.idx));
    members.forEach(it => seen.add(it.idx));
    if (members.length > 0) rawGroups.push(members);
  });
  // Safety net: any index the model dropped or mistyped still gets shown, as its own group.
  items.forEach(it => {
    if (!seen.has(it.idx)) rawGroups.push([it]);
  });

  // Second look at large groups (see splitMixedGroup above) — resolves to a list of member
  // lists per raw group, one list per raw group unless the split check broke it apart further.
  const splitMemberLists = (await runWithConcurrency(rawGroups, async (members) => {
    if (members.length < SPLIT_CHECK_MIN_SIZE) return [members];
    try {
      const subIdGroups = await splitMixedGroup(members);
      // De-dupe against the model repeating the same member index — either twice within one
      // sub-group, or across two different sub-groups (both are real failure modes; the split
      // prompt gives no uniqueness guarantee either way) — first sub-group to claim a member
      // keeps it, same rule as the main clustering pass above, so no feedback item ever lands
      // in two group cards at once.
      const subSeen = new Set();
      const subLists = [];
      subIdGroups.filter(Array.isArray).forEach(list => {
        const uniqueIdxs = Array.from(new Set(list));
        const claimed = uniqueIdxs.map(i => members[i]).filter(Boolean).filter(m => !subSeen.has(m.idx));
        claimed.forEach(m => subSeen.add(m.idx));
        if (claimed.length > 0) subLists.push(claimed);
      });
      members.forEach(m => { if (!subSeen.has(m.idx)) subLists.push([m]); });
      return subLists;
    } catch {
      return [members]; // split check failed — keep the original grouping rather than losing members
    }
  }, SPLIT_CHECK_CONCURRENCY)).flat();

  const mergedMemberLists = await mergeSimilarGroups(splitMemberLists, meaningByIdx);
  const groups = mergedMemberLists.map(members => buildGroup(members, sentimentFn));

  const itemsMeta = {};
  items.forEach(it => {
    itemsMeta[it.f.id] = {
      meaning: meaningByIdx.get(it.idx) || it.text,
      sentiment: sentimentByIdx.get(it.idx) || classifySentiment(it.text),
      text: it.text
    };
  });

  return { groups: groups.sort((a, b) => b.sourceIds.length - a.sourceIds.length), itemsMeta };
}

async function dedupeFeedbackAI(feedback) {
  if (!feedback || feedback.length === 0) return [];
  const { groups } = await computeFullDedup(feedback);
  return groups;
}

// Asks the AI to place a small batch of NEW meanings against the EXISTING groups from a prior
// run, instead of re-clustering everything — used by the cached incremental path so that adding
// a handful of new feedback entries costs one small prompt, not a full re-cluster of the whole
// dataset. Meanings that don't match any existing group come back tagged "new" (or "new-N" if
// several new entries share a second, unrelated new topic) so they can seed fresh groups.
async function assignNewMeanings(newMeanings, existingGroupSummaries) {
  if (newMeanings.length === 0) return [];
  const existingListing = existingGroupSummaries.map(g => `G${g.gidx}: ${g.meaning}`).join('\n') || '(none yet)';
  const newListing = newMeanings.map(m => `N${m.idx}: ${m.meaning}`).join('\n');
  const prompt = `You are incrementally updating an existing set of feedback groups with a small batch of new feedback. Below is a list of EXISTING groups (each with its representative meaning), followed by a list of NEW meanings that need to be placed.

For each NEW meaning, decide: does it describe the exact same underlying point as one of the EXISTING groups? If so, respond with that group's id (e.g. "G3"). If it's a genuinely new point not covered by any existing group, respond "new". If two or more NEW meanings describe the same new point as each other, give them the same label (e.g. "new-1"), and use a different label ("new-2", etc.) for a different new topic.

EXISTING GROUPS:
${existingListing}

NEW MEANINGS:
${newListing}

Respond with ONLY a JSON array, one entry per NEW meaning in order given: [{"idx": <N index>, "assign": "G<id>" or "new" or "new-<label>"}]. No explanation, no markdown fences.`;
  return withRetry(async () => {
    const response = await callFeedbackAI(prompt, 4096);
    const parsed = extractFinalJsonValue(response);
    return Array.isArray(parsed) ? parsed : [];
  });
}

const SUGGEST_BATCH_SIZE = 25;
const SUGGEST_CONCURRENCY = 3;

// For feedback with no real Jira/roadmap date yet, asks the AI whether it clearly relates to the
// same underlying work as something that IS already dated — e.g. an undated complaint about
// login timeouts reads as the same issue as a dated ticket about session expiry — and if so,
// suggests that month with a short reason. Deliberately conservative: told to prefer "no clear
// signal" over a guess, since a wrong suggestion the team accepts without checking is worse than
// no suggestion at all. Batched (like assignNewMeanings) so a large undated backlog costs a
// handful of requests, not one per item.
async function suggestTimelineMonths(undatedItems, datedContext, monthOptions) {
  if (undatedItems.length === 0) return [];
  const allowedMonths = monthOptions.map(o => o.value).join(', ');
  const datedListing = datedContext.map((d, i) => `D${i}: "${d.summary}" — ${d.month}`).join('\n') || '(nothing dated yet)';
  const batches = chunk(undatedItems, SUGGEST_BATCH_SIZE);
  const batchResults = await runWithConcurrency(batches, async (batch) => {
    const undatedListing = batch.map((it, i) => `${i}: ${it.text}`).join('\n---\n');
    const prompt = `You are helping place UNDATED field feedback onto a delivery timeline, using already-dated work as context.

ALREADY-DATED items (for context only — do not suggest placing anything onto these directly, suggest their month instead):
${datedListing}

UNDATED feedback entries (suggest a placement for each, prefixed by index):
${undatedListing}

For each UNDATED entry, decide: does it clearly describe the same underlying issue, feature area, or request as one of the ALREADY-DATED items? If yes, suggest that item's month and give a short reason naming what it matches (e.g. "same login-timeout issue as the dated session-expiry ticket"). If there's no clear, confident connection to any specific dated item, respond with month null and an empty reason — do not guess just to fill in an answer.

Only ever suggest a month from this exact list: ${allowedMonths || '(none available)'}.

Respond with ONLY a JSON array, one entry per UNDATED index given: [{"idx": <number>, "month": "YYYY-MM" or null, "reason": "<short reason>" or ""}]. No explanation, no markdown fences.`;
    return withRetry(async () => {
      const response = await callFeedbackAI(prompt, 4096);
      const parsed = extractFinalJsonValue(response);
      return Array.isArray(parsed) ? parsed : [];
    }).then(results => results.map(r => ({
      groupKey: batch[r?.idx]?.groupKey,
      month: monthOptions.some(o => o.value === r?.month) ? r.month : null,
      reason: typeof r?.reason === 'string' ? r.reason : ''
    })).filter(r => r.groupKey));
  }, SUGGEST_CONCURRENCY);
  return batchResults.flat();
}

// Rebuilds the `groups` shape the rest of the app expects (summary/sentiment/sourceIds/pods)
// from the cache's plain sourceIds lists, using each member's cached sentiment so the AI's
// per-item sentiment read is preserved across cache hits instead of falling back to the
// cruder local keyword heuristic.
function buildGroupsFromCache(cache, byId) {
  const groups = cache.groups.map(g => {
    const members = g.sourceIds
      .map(id => byId.get(id))
      .filter(Boolean)
      .map(f => ({ f, text: combinedText(f) || f.providerName || '(no details)' }));
    if (members.length === 0) return null;
    const sentimentFn = m => cache.items[m.f.id]?.sentiment || classifySentiment(m.text);
    return buildGroup(members, sentimentFn);
  }).filter(Boolean);
  return groups.sort((a, b) => b.sourceIds.length - a.sourceIds.length);
}

// Bump this if the cache's shape ever changes incompatibly, or if the clustering logic itself
// changes enough that old cached groupings should be thrown away and recomputed (e.g. bumped to
// 4 when the merge-check second pass was added — without this, everyone's existing under-merged
// cache would just keep being reused forever via the incremental path). Old/mismatched-version
// caches are just ignored (treated as absent) rather than crashing on a shape they don't recognize.
const DEDUP_CACHE_VERSION = 4;

// If more than half the feedback set (or 50+ items, whichever is larger) is new/changed since
// the last cached run, the incremental "assign new items against existing groups" prompt would
// be doing more work than a plain full re-cluster anyway — and with a much bigger, staler set
// of "existing" groups to compare against. Simpler and more reliable to just recompute fully
// and reseed the cache from scratch.
function isBigDelta(idsToProcess, totalFeedbackCount) {
  return idsToProcess.length > Math.max(50, totalFeedbackCount * 0.5);
}

// Cached, incremental version of dedupeFeedbackAI: persists the AI's analysis (per-item
// extracted meaning/sentiment + the final groups) to Postgres, keyed by initiative, so that
// re-opening a tab with unchanged feedback skips the AI pipeline entirely, and adding a few
// new entries only costs analyzing those entries — not the whole dataset again. Falls back to
// a full, uncached recompute (dedupeFeedbackAI's old behavior) whenever the cache is missing,
// unusable, or anything in the incremental path throws, so a cache problem never breaks the UI.
async function dedupeFeedbackAICached(feedback, initiativeId) {
  if (!feedback || feedback.length === 0) return [];
  if (!initiativeId) return dedupeFeedbackAI(feedback);

  const byId = new Map(feedback.map(f => [f.id, f]));
  const textOf = f => combinedText(f) || f.providerName || '(no details)';

  let cache;
  try {
    cache = await loadDedupCache(initiativeId);
  } catch {
    return dedupeFeedbackAI(feedback);
  }

  if (!cache || cache.version !== DEDUP_CACHE_VERSION || !cache.items || !cache.groups) {
    const { groups, itemsMeta } = await computeFullDedup(feedback);
    const seeded = { version: DEDUP_CACHE_VERSION, items: itemsMeta, groups: groups.map(g => ({ sourceIds: g.sourceIds })) };
    await saveDedupCache(initiativeId, seeded).catch(() => {});
    return groups;
  }

  try {
    const currentIds = new Set(feedback.map(f => f.id));
    const cachedIdSet = new Set(Object.keys(cache.items));
    const removedIds = Array.from(cachedIdSet).filter(id => !currentIds.has(id));
    // An id that's still present but whose text changed needs re-analysis just like a brand
    // new entry — and must be pulled out of whatever group it was cached under, since that
    // group was formed around its OLD meaning.
    const changedIds = feedback
      .filter(f => cachedIdSet.has(f.id) && cache.items[f.id].text !== textOf(f))
      .map(f => f.id);
    const newIds = feedback.map(f => f.id).filter(id => !cachedIdSet.has(id));
    const idsToProcess = [...newIds, ...changedIds];

    if (isBigDelta(idsToProcess, feedback.length)) {
      const { groups, itemsMeta } = await computeFullDedup(feedback);
      const seeded = { version: DEDUP_CACHE_VERSION, items: itemsMeta, groups: groups.map(g => ({ sourceIds: g.sourceIds })) };
      await saveDedupCache(initiativeId, seeded).catch(() => {});
      return groups;
    }

    const idsToStrip = new Set([...removedIds, ...changedIds]);
    idsToStrip.forEach(id => delete cache.items[id]);
    cache.groups = cache.groups
      .map(g => ({ sourceIds: g.sourceIds.filter(id => !idsToStrip.has(id)) }))
      .filter(g => g.sourceIds.length > 0);

    if (idsToProcess.length === 0) {
      if (idsToStrip.size > 0) await saveDedupCache(initiativeId, cache).catch(() => {});
      return buildGroupsFromCache(cache, byId);
    }

    const items = idsToProcess.map((id, idx) => ({ idx, f: byId.get(id), text: textOf(byId.get(id)) }));
    const extracted = await extractMeanings(items);
    const meaningByIdx = new Map();
    const sentimentByIdx = new Map();
    extracted.forEach(e => {
      if (!e || typeof e.idx !== 'number') return;
      if (e.meaning) meaningByIdx.set(e.idx, e.meaning);
      sentimentByIdx.set(e.idx, normalizeSentiment(e.sentiment));
    });

    // Deterministic free merge first: an existing group already containing this exact
    // (normalized) meaning means the new item is certainly the same point — no AI needed.
    const keyToExistingGroupIdx = new Map();
    cache.groups.forEach((g, gidx) => {
      g.sourceIds.forEach(id => {
        const cached = cache.items[id];
        if (cached) keyToExistingGroupIdx.set(normalizeMeaningKey(cached.meaning), gidx);
      });
    });

    const stillNew = [];
    items.forEach((it, i) => {
      const meaning = meaningByIdx.get(i) || it.text;
      const sentiment = sentimentByIdx.get(i) || classifySentiment(it.text);
      cache.items[it.f.id] = { meaning, sentiment, text: it.text };
      const key = normalizeMeaningKey(meaning);
      if (keyToExistingGroupIdx.has(key)) {
        cache.groups[keyToExistingGroupIdx.get(key)].sourceIds.push(it.f.id);
      } else {
        stillNew.push({ id: it.f.id, meaning, key });
      }
    });

    if (stillNew.length > 0) {
      const existingGroupSummaries = cache.groups.map((g, gidx) => ({
        gidx, meaning: cache.items[g.sourceIds[0]]?.meaning || ''
      }));
      const newMeaningsForAssign = stillNew.map((n, idx) => ({ idx, meaning: n.meaning }));
      const assignments = await assignNewMeanings(newMeaningsForAssign, existingGroupSummaries);

      const assignedIdxs = new Set();
      const newLabelToGroup = new Map();
      assignments.forEach(a => {
        if (!a || typeof a.idx !== 'number' || !stillNew[a.idx] || assignedIdxs.has(a.idx)) return;
        assignedIdxs.add(a.idx);
        const item = stillNew[a.idx];
        const assign = String(a.assign || 'new');
        const gMatch = /^G(\d+)$/.exec(assign);
        if (gMatch && cache.groups[Number(gMatch[1])]) {
          cache.groups[Number(gMatch[1])].sourceIds.push(item.id);
          return;
        }
        if (!newLabelToGroup.has(assign)) newLabelToGroup.set(assign, { sourceIds: [] });
        newLabelToGroup.get(assign).sourceIds.push(item.id);
      });
      // Safety net: anything the model dropped or mistyped still becomes its own new group
      // rather than silently disappearing from the results.
      stillNew.forEach((item, idx) => {
        if (!assignedIdxs.has(idx)) cache.groups.push({ sourceIds: [item.id] });
      });
      cache.groups.push(...Array.from(newLabelToGroup.values()));
    }

    cache.version = DEDUP_CACHE_VERSION;
    await saveDedupCache(initiativeId, cache).catch(() => {});
    return buildGroupsFromCache(cache, byId);
  } catch (e) {
    return dedupeFeedbackAI(feedback);
  }
}

// Groups feedback by meaning automatically via the AI gateway, falling back to the local
// token-matcher (instantly, so the UI never blocks or breaks) when no key is set or the AI
// call/parse fails. `status` lets callers show a small hint about which path is active.
// `initiativeId` keys the persisted dedup cache — without it (e.g. an ungrouped list of
// feedback with no single initiative) this just runs the uncached full pipeline every time.
function useDedupedFeedback(feedback, initiativeId) {
  const [state, setState] = useState(() => ({ groups: dedupeFeedback(feedback), status: 'local' }));

  useEffect(() => {
    let cancelled = false;
    setState(s => ({ groups: dedupeFeedback(feedback), status: 'loading' }));
    dedupeFeedbackAICached(feedback, initiativeId)
      .then(groups => { if (!cancelled) setState({ groups, status: 'ai' }); })
      .catch(err => {
        if (cancelled) return;
        setState({ groups: dedupeFeedback(feedback), status: err.message === 'NO_KEY' ? 'no-key' : 'error' });
      });
    return () => { cancelled = true; };
  }, [feedback, initiativeId]);

  return state;
}

export {
  dedupeFeedback, dedupeFeedbackAI, dedupeFeedbackAICached, useDedupedFeedback, PODS, PEOPLE_EMAILS, feedbackDetailText,
  matchJiraIssue, normalize, STOPWORDS, DeliveryBadges, combinedText, jiraStatusBucket, suggestTimelineMonths
};

export default function FeedbackAnalysisPanel({ feedback, initiative, data, onDataChange, groups, status }) {
  const [expandedGroup, setExpandedGroup] = useState(null);
  const [showJiraSync, setShowJiraSync] = useState(false);
  const [showWordCloud, setShowWordCloud] = useState(false);
  const [monthFilter, setMonthFilter] = useState('all');
  const [jiraFilter, setJiraFilter] = useState('all');

  const jiraIssues = data?.jiraIssues || [];
  const feedbackById = useMemo(() => new Map(feedback.map(f => [f.id, f])), [feedback]);

  // Which month a group "came in" — same latestDate buildGroup already tags every group with
  // (most recent collection date among its members), reused here instead of a second concept of
  // "the" date for a group.
  const monthOptions = useMemo(() => {
    const keys = new Set(groups.map(g => monthKey(g.latestDate)).filter(Boolean));
    return Array.from(keys).sort().reverse();
  }, [groups]);

  const monthFiltered = useMemo(
    () => (monthFilter === 'all' ? groups : groups.filter(g => monthKey(g.latestDate) === monthFilter)),
    [groups, monthFilter]
  );

  // Count computed off the month-filtered set (not the full group list) so the button's own
  // number always matches what clicking it would actually show.
  const untaggedCount = useMemo(
    () => monthFiltered.filter(g => !matchJiraIssue(g.summary, jiraIssues)).length,
    [monthFiltered, jiraIssues]
  );

  const visibleGroups = useMemo(
    () => (jiraFilter === 'untagged' ? monthFiltered.filter(g => !matchJiraIssue(g.summary, jiraIssues)) : monthFiltered),
    [monthFiltered, jiraFilter, jiraIssues]
  );

  const negative = visibleGroups.filter(g => g.sentiment === 'Negative');
  const positive = visibleGroups.filter(g => g.sentiment === 'Positive');
  const neutral = visibleGroups.filter(g => g.sentiment === 'Neutral');
  // Requests/questions live in the same "Needs Improvement" list as real complaints — still
  // actionable, just tagged differently in the card so the two aren't visually confused.
  const needsImprovement = visibleGroups.filter(g => g.sentiment !== 'Positive');

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#032D60' }}>Feedback Analysis</h2>
          <p style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
            {feedback.length} field input{feedback.length !== 1 ? 's' : ''} for {initiative.name}, deduplicated by matching meaning — not just exact wording — so paraphrased reports of the same issue collapse into one, then split into positive feedback and needs-improvement (issues and requests/questions, tagged separately), and cross-checked against the Jira backlog and roadmap so already-planned work is flagged.
          </p>
          <DedupStatusNote status={status} />
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {needsImprovement.length > 0 && (
            <button onClick={() => setShowWordCloud(v => !v)} style={styles.jiraSyncBtn}>
              ☁️ {showWordCloud ? 'Hide' : 'Show'} Word Cloud ({needsImprovement.length})
            </button>
          )}
          {data && onDataChange && (
            <button onClick={() => setShowJiraSync(true)} style={styles.jiraSyncBtn}>
              🔄 {jiraIssues.length > 0 ? `Re-sync Jira (${jiraIssues.length})` : 'Sync Jira Status'}
            </button>
          )}
        </div>
      </div>

      {feedback.length === 0 ? (
        <div style={styles.empty}>No feedback logged for this initiative yet.</div>
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <select value={monthFilter} onChange={e => setMonthFilter(e.target.value)} style={styles.monthSelect}>
              <option value="all">All months</option>
              {monthOptions.map(key => (
                <option key={key} value={key}>{monthLabel(key)}</option>
              ))}
            </select>
            <button
              onClick={() => setJiraFilter(f => (f === 'untagged' ? 'all' : 'untagged'))}
              style={jiraFilter === 'untagged' ? styles.jiraFilterBtnActive : styles.jiraFilterBtn}
            >
              🚫 No Jira ticket ({untaggedCount})
            </button>
          </div>

          <div style={styles.summaryBar}>
            <span><strong>{visibleGroups.length}</strong> unique point{visibleGroups.length !== 1 ? 's' : ''} after dedup</span>
            <span style={{ color: '#9ca3af' }}>·</span>
            <span style={{ color: '#dc2626' }}>{needsImprovement.length} needs improvement</span>
            <span style={{ color: '#9ca3af', fontSize: 11 }}>({negative.length} issues, {neutral.length} requests/questions)</span>
            <span style={{ color: '#9ca3af' }}>·</span>
            <span style={{ color: '#059669' }}>{positive.length} positive</span>
          </div>

          {showWordCloud && (
            <WordCloud
              texts={needsImprovement.map(g => g.summary)}
              title={`Most common phrases across ${needsImprovement.length} unique needs-improvement points (bigger = more frequent)`}
            />
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <GroupColumn
              title="🔴 Needs Improvement"
              subtitle={`${needsImprovement.length} point${needsImprovement.length !== 1 ? 's' : ''}`}
              groupsList={needsImprovement}
              feedbackById={feedbackById}
              expandedGroup={expandedGroup}
              setExpandedGroup={setExpandedGroup}
              accent="#dc2626"
              keyPrefix="neg"
              jiraIssues={jiraIssues}
            />
            <GroupColumn
              title="🟢 Working Well"
              subtitle={`${positive.length} point${positive.length !== 1 ? 's' : ''}`}
              groupsList={positive}
              feedbackById={feedbackById}
              expandedGroup={expandedGroup}
              setExpandedGroup={setExpandedGroup}
              accent="#059669"
              keyPrefix="pos"
              jiraIssues={jiraIssues}
            />
          </div>
        </div>
      )}

      {showJiraSync && (
        <JiraSyncPanel data={data} onDataChange={onDataChange} onClose={() => setShowJiraSync(false)} />
      )}
    </div>
  );
}

function DedupStatusNote({ status }) {
  if (status === 'ai') return <p style={{ fontSize: 11, color: '#7c3aed', marginTop: 4 }}>✨ Grouped by AI (meaning-based)</p>;
  if (status === 'loading') return <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>⏳ Asking AI to group by meaning...</p>;
  if (status === 'no-key') return <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Using local word-matching — set your LLM Gateway key (🔑 icon above) for AI-powered grouping.</p>;
  if (status === 'error') return <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Using local word-matching — AI grouping failed, falling back automatically.</p>;
  return null;
}

// Distinguishes a real complaint from a plain request/question within the shared "Needs
// Improvement" list — both are actionable, but a pod triaging the list shouldn't mistake
// "what does this field do?" for an actual bug report.
function SentimentTag({ sentiment }) {
  if (sentiment === 'Neutral') {
    return (
      <span style={{ fontSize: 10, fontWeight: 700, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '1px 7px', marginBottom: 6, display: 'inline-block' }}>
        🟡 Request / Question
      </span>
    );
  }
  if (sentiment === 'Negative') {
    return (
      <span style={{ fontSize: 10, fontWeight: 700, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '1px 7px', marginBottom: 6, display: 'inline-block' }}>
        🔴 Issue
      </span>
    );
  }
  return null;
}

function GroupColumn({ title, subtitle, groupsList, feedbackById, expandedGroup, setExpandedGroup, accent, keyPrefix, jiraIssues }) {
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: '#1f2937' }}>{title}</span>
        <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>{subtitle} · {groupsList.length}</span>
      </div>
      {groupsList.length === 0 ? (
        <div style={{ ...styles.empty, padding: 20 }}>None found.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groupsList.map((g, idx) => {
            const key = `${keyPrefix}-${idx}`;
            const matched = g.sourceIds.map(id => feedbackById.get(id)).filter(Boolean);
            const regions = Array.from(new Set(matched.map(f => f.region).filter(Boolean)));
            const reporters = Array.from(new Set(matched.map(f => (f.providerName || '').trim()).filter(Boolean)));
            const isOpen = expandedGroup === key;
            const jiraMatch = matchJiraIssue(g.summary, jiraIssues);
            const roadmapMatch = matchRoadmap(g.summary);
            return (
              <div key={key} style={{ ...styles.card, borderLeft: `4px solid ${accent}` }}>
                {g.latestDate && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, background: '#fef9c3', color: '#854d0e', padding: '2px 8px', borderRadius: 10 }}>
                      {monthKey(g.latestDate).slice(5, 7)}/{monthKey(g.latestDate).slice(0, 4)}
                    </span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <SentimentTag sentiment={g.sentiment} />
                    <p style={{ fontSize: 14, color: '#1f2937', lineHeight: 1.5, marginBottom: 6 }}>{g.summary}</p>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: '#6b7280' }}>
                      {reporters.length > 1 ? (
                        <span title={reporters.join(', ')} style={{ fontWeight: 600, color: '#374151' }}>
                          👥 {reporters.length} people reported this{matched.length > reporters.length ? ` (${matched.length} submissions)` : ''}
                        </span>
                      ) : (
                        <span>📣 {matched.length} report{matched.length !== 1 ? 's' : ''}</span>
                      )}
                      {regions.length > 0 && <span>🌍 {regions.join(', ')}</span>}
                    </div>
                    {/* Pod badge disabled — Pod Tracker tab is disabled too, see InitiativeDetail.js
                    {keyPrefix === 'neg' && <PodBadges pods={g.pods} />}
                    */}
                    <DeliveryBadges jiraMatch={jiraMatch} roadmapMatch={roadmapMatch} />
                  </div>
                  <button onClick={() => setExpandedGroup(isOpen ? null : key)} style={styles.smallBtn}>
                    {isOpen ? '▲' : `${matched.length} ▼`}
                  </button>
                </div>
                {isOpen && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #e5e7eb' }}>
                    {matched.map(f => (
                      <div key={f.id} style={styles.sourceRow}>
                        <strong>{f.providerName}</strong>
                        {f.providerRole && <span style={{ color: '#6b7280' }}> · {f.providerRole}</span>}
                        <span style={{ color: '#6b7280' }}> · {f.region} · {f.date}</span>
                        <div style={{ color: '#374151', marginTop: 2 }}>{feedbackDetailText(f)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Explicit per-status tagging for the SEPSP board's own workflow (requested over inferring
// from Jira's statusCategory, which only has 3 buckets and — via sprintState — used to make
// "Open" ambiguous depending on sprint timing). Closed is the only "done" status; Open is
// always "planned"; every other named status on this workflow means someone is actively on it.
const STATUS_BUCKET_TAGS = {
  closed: 'done',
  open: 'planned',
  'ready for implementation': 'in-progress',
  blocked: 'in-progress',
  'in progress': 'in-progress',
  'in test': 'in-progress',
  'on hold': 'in-progress',
  'ready for demo': 'in-progress',
  'ready for test': 'in-progress',
  'ready to deploy': 'in-progress'
};

// Buckets a matched Jira ticket into three broad delivery states. Checks the explicit tag
// table above first; falls back to Jira's own statusCategory/sprintState (and, lacking that,
// a text-regex guess) for any status name this workflow hasn't been explicitly tagged for —
// e.g. a different board/project, or a new status added to this one later.
function jiraStatusBucket(jiraMatch) {
  const statusName = ((jiraMatch && jiraMatch.status) || '').toLowerCase().trim();
  if (STATUS_BUCKET_TAGS[statusName]) return STATUS_BUCKET_TAGS[statusName];
  if (jiraMatch && jiraMatch.statusCategory) {
    if (jiraMatch.statusCategory === 'done') return 'done';
    if (jiraMatch.statusCategory === 'indeterminate') return 'in-progress';
    // "To Do" category: only really "in progress" if it's sitting in the sprint happening
    // right now (about to be picked up) — otherwise it's future/unscheduled work.
    return jiraMatch.sprintState === 'active' ? 'in-progress' : 'planned';
  }
  if (/(done|closed|resolved|deployed|released)/.test(statusName)) return 'done';
  if (/(progress|review|dev|testing|qa|staged)/.test(statusName)) return 'in-progress';
  return 'planned';
}

const JIRA_BUCKET_STYLE = {
  done: { color: '#059669', background: '#ecfdf5', border: '#a7f3d0', label: '✓ Done' },
  'in-progress': { color: '#0369a1', background: '#eff6ff', border: '#bfdbfe', label: '🔧 In Progress' },
  planned: { color: '#6b7280', background: '#f3f4f6', border: '#e5e7eb', label: '📋 Planned' }
};

function DeliveryBadges({ jiraMatch, roadmapMatch }) {
  if (!jiraMatch && !roadmapMatch) return null;
  return (
    <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {jiraMatch && (() => {
        const bucket = JIRA_BUCKET_STYLE[jiraStatusBucket(jiraMatch)];
        // "Planned" gets the sprint name in the label when we know one (e.g. a future sprint
        // it's already scheduled into) — "we're planning to work on it" is a lot more concrete
        // with a target sprint attached than a bare "Planned".
        const label = jiraStatusBucket(jiraMatch) === 'planned' && jiraMatch.sprint
          ? `📅 Planned · ${jiraMatch.sprint}`
          : bucket.label;
        const title = [
          `${jiraMatch.key}: ${jiraMatch.summary} (${jiraMatch.status})`,
          jiraMatch.parentSummary ? `Epic: ${jiraMatch.parentSummary}` : null,
          jiraMatch.sprint ? `Sprint: ${jiraMatch.sprint}` : null,
          jiraMatch.fixVersion ? `Fix Version: ${jiraMatch.fixVersion}` : null,
          jiraMatch.resolution ? `Resolution: ${jiraMatch.resolution}` : null,
          jiraMatch.resolutionNote ? `Note: ${jiraMatch.resolutionNote}` : null
        ].filter(Boolean).join(' · ');
        return (
          <span
            style={{ fontSize: 11, fontWeight: 600, color: bucket.color, background: bucket.background, border: `1px solid ${bucket.border}`, borderRadius: 12, padding: '3px 10px' }}
            title={title}>
            {label} · {jiraMatch.key}
          </span>
        );
      })()}
      {jiraMatch?.fixVersion && (
        // Shown as its own tag, separate from the status badge, so which release a ticket is
        // tied to is visible on the card itself rather than only in the status badge's tooltip.
        <span style={styles.fixVersionBadge} title={`Fix Version: ${jiraMatch.fixVersion}`}>
          🏷️ {jiraMatch.fixVersion}
        </span>
      )}
      {roadmapMatch && (
        <span style={styles.roadmapBadge} title={roadmapMatch.level === 'item' ? `Scheduled: ${roadmapMatch.name}` : `Touches the ${roadmapMatch.name} roadmap area`}>
          📅 {roadmapMatch.level === 'item' ? `Planned ${roadmapMatch.target}` : `Roadmap: ${roadmapMatch.name}`}
        </span>
      )}
    </div>
  );
}

function PodBadges({ pods }) {
  if (!pods || pods.length === 0) {
    return (
      <div style={{ marginTop: 8 }}>
        <span style={styles.triageBadge} title="No pod keyword matched — route this manually">
          ⚠️ Needs Triage
        </span>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {pods.map(pod => (
        <span key={pod.key} style={styles.podBadge}
          title={`${pod.focus} — Lead: ${pod.lead}${pod.members.length ? ', ' + pod.members.join(', ') : ''}`}>
          🔔 Notify {pod.name} · {pod.lead}
        </span>
      ))}
    </div>
  );
}

const styles = {
  summaryBar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, color: '#374151', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px', marginBottom: 16 },
  podBadge: { fontSize: 11, fontWeight: 600, color: '#0176D3', background: '#eaf4fd', border: '1px solid #bfe0fa', borderRadius: 12, padding: '3px 10px', cursor: 'default' },
  triageBadge: { fontSize: 11, fontWeight: 600, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 12, padding: '3px 10px', cursor: 'default' },
  empty: { background: '#fff', borderRadius: 8, padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 14, border: '1px dashed #e5e7eb' },
  card: { background: '#fff', borderRadius: 8, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' },
  smallBtn: { fontSize: 12, border: '1px solid #d1d5db', borderRadius: 5, padding: '4px 9px', cursor: 'pointer', background: '#fff', whiteSpace: 'nowrap' },
  sourceRow: { fontSize: 13, padding: '6px 0', borderBottom: '1px solid #f3f4f6' },
  jiraSyncBtn: { fontSize: 13, fontWeight: 600, color: '#0176D3', background: '#eaf4fd', border: '1px solid #bfe0fa', borderRadius: 6, padding: '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap' },
  roadmapBadge: { fontSize: 11, fontWeight: 600, color: '#7c3aed', background: '#f3e8ff', border: '1px solid #ddd6fe', borderRadius: 12, padding: '3px 10px', cursor: 'default' },
  fixVersionBadge: { fontSize: 11, fontWeight: 600, color: '#9d174d', background: '#fdf2f8', border: '1px solid #fbcfe8', borderRadius: 12, padding: '3px 10px', cursor: 'default' },
  monthSelect: { fontSize: 13, color: '#374151', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' },
  jiraFilterBtn: { fontSize: 13, fontWeight: 600, color: '#374151', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap' },
  jiraFilterBtnActive: { fontSize: 13, fontWeight: 600, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }
};
