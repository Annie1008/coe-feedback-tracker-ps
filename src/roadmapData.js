// Static reference data extracted from "Solution IQ 3-Release-Roadmap(3RR) and Planning.xlsx"
// (Sheet1 tab — the clean per-domain, per-month breakdown of what's shipping when). Kept as
// plain data (not parsed from the spreadsheet at runtime) since roadmaps change slowly and
// change by hand, not by re-upload.
//
// Two levels of matching on purpose:
//  - DOMAIN keywords: broad, high-recall — "does this feedback touch Scope & Solution at all".
//  - NEAR_TERM_ITEMS: specific named line items with a real target month (Sep/Oct/Nov/Dec 2026,
//    the four columns the roadmap actually commits dates to). Matched by token coverage against
//    the item's own name — same technique as the Jira title matcher — rather than hand-written
//    keyword lists, since there are 90+ auto-extracted items and hand-keywording each one isn't
//    feasible to keep in sync with a spreadsheet that gets re-edited independently of this repo.
const DOMAINS = [
  {
    key: 'scope_solution', name: 'Scope & Solution',
    keywords: ['scope', 'out of scope', 'out-of-scope', 'assumption', 'confidence score', 'fixed bid', 'multi-cloud', 'multi cloud', 'dependencies', 'build sequencing', 'data flows', 'integrations', 'commercial model', 'resource recommendation', 'persona', 'deal qualification', 'language support', 'advisory only']
  },
  {
    key: 'estimate_pricing', name: 'Estimate & Pricing',
    keywords: ['estimate', 'pricing', 'price', 'effort', 'hours', 'hrs calculation', 'rom range', 'scenario modeler', 'scenario versioning', 'custom scope', 'timeline compression', 'benchmark', 'everest', 'margin', 'discount', 'staleness', 'stale', 'descope', 'target price', 'justification']
  },
  {
    key: 'risk_governance', name: 'Risk & Governance',
    keywords: ['risk', 'gsrm', 'sds', 'contingency', 'risk scoring', 'complexity tier', 'audit trail', 'predictive pricing', 'expiration', 'override', 'escalation', 'governance', 'waive']
  },
  {
    key: 'resource_staffing', name: 'Resource & Staffing',
    keywords: ['staffing', 'resource', 'fractional', 'ramp on', 'ramp off', 'onshore', 'offshore', 'recommended team', 'gdc', 'delivery model', 'pubsec', 'advisory team', 'ocm', 'location override', 'rate card', 'seniority', 'pod model', 'fixed capacity', 'capacity']
  },
  {
    key: 'proposal_handoff', name: 'Proposal & Handoff',
    keywords: ['proposal', 'handoff', 'org62', 'loe template', 'cmmi', 'auto-generated', 'auto compiled', 'handoff package']
  },
  {
    key: 'packaged_offerings', name: 'Packaged Offerings',
    keywords: ['package', 'packaged offering', 'catalog', 'locked package', 'aes', 'advisory only', 'implementation only', 'package customization', 'work units', 'attribution tracking', 'modernization']
  },
  {
    key: 'analytics_reporting', name: 'Analytics & Reporting',
    keywords: ['dashboard', 'analytics', 'reporting', 'my deals', 'staleness alert', 'qa triage', 'pilot adoption', 'tool usage', 'completion rate', 'time-to-estimate', 'workforce', 'utilization', 'variance', 'benchmark update', 'portfolio dashboard', 'win rate']
  }
];

// Extracted from Sheet1 of the roadmap workbook: one row per domain, one column per committed
// month (Sep/Oct/Nov/Dec 2026), each cell a newline-separated list of line items. 92 items total.
const NEAR_TERM_ITEMS = [
  { domain: 'Clouds/Delivery Model Summary', target: 'Sep 2026', name: 'Single-cloud scoping for 6+ 3 (WIP) clouds: Sales Cloud, Service Cloud, Consumer Goods, Life Science, Marketing Cloud & MC Next, Agentforce, WIP/Potential - Mulesoft, Experience cloud, Data Cloud' },
  { domain: 'Clouds/Delivery Model Summary', target: 'Sep 2026', name: 'Traditional Delivery Model' },
  { domain: 'Clouds/Delivery Model Summary', target: 'Oct 2026', name: 'Multi-cloud scoping for 8 clouds: Data Cloud, MuleSoft, Experience Cloud, Tableau, Financial Services Cloud, Revenue Cloud,, Field Service, Commerce Cloud, Claudeforce[TBD]' },
  { domain: 'Clouds/Delivery Model Summary', target: 'Oct 2026', name: 'AI Delivery Model' },
  { domain: 'Clouds/Delivery Model Summary', target: 'Nov 2026', name: 'Slack, Commerce Cloud (B2B + B2C), Retail Cloud, Health Cloud, Digital Insurance Cloud, Manufacturing Cloud, Communications Cloud' },
  { domain: 'Scope & Solution', target: 'Sep 2026', name: 'AI Extracts Scope from Uploaded Documents' },
  { domain: 'Scope & Solution', target: 'Sep 2026', name: 'Confidence Score + Assumptions' },
  { domain: 'Scope & Solution', target: 'Sep 2026', name: 'Out of Scope' },
  { domain: 'Scope & Solution', target: 'Sep 2026', name: 'Fixed Bid Block for Low Scope' },
  { domain: 'Scope & Solution', target: 'Sep 2026', name: 'Scope priority star flag' },
  { domain: 'Scope & Solution', target: 'Oct 2026', name: 'Deal Qualification MVP' },
  { domain: 'Scope & Solution', target: 'Oct 2026', name: 'Commercial Model Recommendation' },
  { domain: 'Scope & Solution', target: 'Oct 2026', name: 'Build sequencing - Data flows + Integrations' },
  { domain: 'Scope & Solution', target: 'Oct 2026', name: 'Multi-cloud scope combination (dedup shared components)' },
  { domain: 'Scope & Solution', target: 'Oct 2026', name: 'Per-cloud Resource Recommendation (Joyce framework)' },
  { domain: 'Scope & Solution', target: 'Nov 2026', name: 'Deal Qualification MVP+' },
  { domain: 'Scope & Solution', target: 'Nov 2026', name: 'Custom Scope' },
  { domain: 'Scope & Solution', target: 'Nov 2026', name: 'Multi Language Support' },
  { domain: 'Scope & Solution', target: 'Nov 2026', name: 'Advisory Only deal path (Deal type selection (Advisory Only / Implementation Only / Both)' },
  { domain: 'Scope & Solution', target: 'Nov 2026', name: 'Personas' },
  { domain: 'Estimate & Pricing', target: 'Sep 2026', name: 'Effort and Hrs Calculation' },
  { domain: 'Estimate & Pricing', target: 'Sep 2026', name: 'ROM Range Calculation' },
  { domain: 'Estimate & Pricing', target: 'Sep 2026', name: 'Scenario Modeler MVP' },
  { domain: 'Estimate & Pricing', target: 'Oct 2026', name: 'Custom Scope' },
  { domain: 'Estimate & Pricing', target: 'Oct 2026', name: 'Advisory Scope' },
  { domain: 'Estimate & Pricing', target: 'Oct 2026', name: 'Timeline Compression Alert' },
  { domain: 'Estimate & Pricing', target: 'Oct 2026', name: 'Industry Benchmark (Everest) Tracking' },
  { domain: 'Estimate & Pricing', target: 'Oct 2026', name: 'AI Delivery Efficiency Reductions (pricing reduction requires approval - pricing request).' },
  { domain: 'Estimate & Pricing', target: 'Oct 2026', name: 'Advisory hours = Implementation Hrs x Role %' },
  { domain: 'Estimate & Pricing', target: 'Oct 2026', name: 'Scenario Modeler MVP+' },
  { domain: 'Estimate & Pricing', target: 'Oct 2026', name: 'Target-price solver (auto lever combos)' },
  { domain: 'Estimate & Pricing', target: 'Oct 2026', name: 'Margin optimization suggestions' },
  { domain: 'Estimate & Pricing', target: 'Nov 2026', name: 'Price Change Justification' },
  { domain: 'Estimate & Pricing', target: 'Nov 2026', name: 'Margin & Price Targets' },
  { domain: 'Estimate & Pricing', target: 'Nov 2026', name: 'Discounting Overrides' },
  { domain: 'Estimate & Pricing', target: 'Nov 2026', name: 'Estimate staleness (60-day, warning day 55)' },
  { domain: 'Estimate & Pricing', target: 'Nov 2026', name: 'Descope solver — suggests what to cut to hit a target price' },
  { domain: 'Estimate & Pricing', target: 'Dec 2026', name: 'Scenario versioning — stale scenarios locked when baseline changes' },
  { domain: 'Risk & Governance', target: 'Oct 2026', name: 'Risk Rating GSRM/SDS Risk inclusion' },
  { domain: 'Risk & Governance', target: 'Oct 2026', name: 'Contingency' },
  { domain: 'Risk & Governance', target: 'Oct 2026', name: '12-factor risk scoring (0-30% by commercial model)' },
  { domain: 'Risk & Governance', target: 'Oct 2026', name: 'Scope Complexity Tier (deal-level validation)' },
  { domain: 'Risk & Governance', target: 'Nov 2026', name: 'Full Audit Trail' },
  { domain: 'Risk & Governance', target: 'Nov 2026', name: 'Predictive pricing from deal history' },
  { domain: 'Risk & Governance', target: 'Nov 2026', name: 'Deal Expirations & Stale alert' },
  { domain: 'Risk & Governance', target: 'Dec 2026', name: 'Overrides Logged for Approvers' },
  { domain: 'Risk & Governance', target: 'Dec 2026', name: 'Escalation triggers' },
  { domain: 'Resource & Staffing', target: 'Sep 2026', name: 'Fractional / Ramp on/off (Everest phase patterns)' },
  { domain: 'Resource & Staffing', target: 'Sep 2026', name: 'Location framework (onshore/offshore)' },
  { domain: 'Resource & Staffing', target: 'Sep 2026', name: 'Recommended team per cloud x tier (MVP)' },
  { domain: 'Resource & Staffing', target: 'Sep 2026', name: "GDC %'s Tracking" },
  { domain: 'Resource & Staffing', target: 'Oct 2026', name: 'Governance % check (tier-adjusted)' },
  { domain: 'Resource & Staffing', target: 'Oct 2026', name: 'AI Efficiency per Delivery Model' },
  { domain: 'Resource & Staffing', target: 'Oct 2026', name: 'AI Team Skills and Delivery models' },
  { domain: 'Resource & Staffing', target: 'Oct 2026', name: 'Ai Recommended team structure (fractal/ramp/etc)' },
  { domain: 'Resource & Staffing', target: 'Oct 2026', name: 'Advisory team derivation (HCC, Experience, BSC, TA Advisory)' },
  { domain: 'Resource & Staffing', target: 'Nov 2026', name: 'OCM proportionality (2-12%)' },
  { domain: 'Resource & Staffing', target: 'Nov 2026', name: 'Location Overrides Require Justification' },
  { domain: 'Resource & Staffing', target: 'Nov 2026', name: 'Rate Card Auto-lookup Per Role' },
  { domain: 'Resource & Staffing', target: 'Nov 2026', name: 'Everest Seniority Pyramid check' },
  { domain: 'Resource & Staffing', target: 'Nov 2026', name: 'Split Location / Pod Model (2+ same grade = offshore 2nd)' },
  { domain: 'Resource & Staffing', target: 'Nov 2026', name: 'PubSec modifier (duration x 2-3x, onshore override, mandatory EM)' },
  { domain: 'Resource & Staffing', target: 'Dec 2026', name: 'Fixed Capacity — scoper builds resource plan directly (no calc)' },
  { domain: 'Resource & Staffing', target: 'Dec 2026', name: 'Fixed Capacity — scope-fit check (warns if scope exceeds 80% of capacity)' },
  { domain: 'Proposal & Handoff', target: 'Oct 2026', name: 'Org62 estimate sync (write-only)' },
  { domain: 'Proposal & Handoff', target: 'Oct 2026', name: 'PDF generation MVP (Collaborative Scoping MVP)' },
  { domain: 'Proposal & Handoff', target: 'Nov 2026', name: 'Proposal auto-generated' },
  { domain: 'Proposal & Handoff', target: 'Nov 2026', name: 'Handoff package auto-compiled' },
  { domain: 'Proposal & Handoff', target: 'Nov 2026', name: 'PubSec LOE Template export (CMMI)' },
  { domain: 'Packaged Offerings (Modernization)', target: 'Nov 2026', name: '3-path: Advisory Only / Implementation Only / Both' },
  { domain: 'Packaged Offerings (Modernization)', target: 'Nov 2026', name: 'System Recommends Package' },
  { domain: 'Packaged Offerings (Modernization)', target: 'Nov 2026', name: 'Package customization threshold — when modifications break the package' },
  { domain: 'Packaged Offerings (Modernization)', target: 'Dec 2026', name: 'Customizable Package from Catalog' },
  { domain: 'Packaged Offerings (Modernization)', target: 'Dec 2026', name: 'Ability to Add Scope to Packaged Offerings' },
  { domain: 'Packaged Offerings (Modernization)', target: 'Dec 2026', name: 'Locked packages (AES) — comp-tied, skip scoping' },
  { domain: 'Packaged Offerings (Modernization)', target: 'Dec 2026', name: 'Package Success Metrics' },
  { domain: 'Packaged Offerings (Modernization)', target: 'Dec 2026', name: 'Work Units & Outcomes in proposals' },
  { domain: 'Packaged Offerings (Modernization)', target: 'Dec 2026', name: 'Attribution Tracking' },
  { domain: 'Packaged Offerings (Modernization)', target: 'Dec 2026', name: 'Standard/Enhanced/Custom classification' },
  { domain: 'Analytics & Reporting', target: 'Oct 2026', name: 'Reporting of # of Deals scoped, SSSL Attributes(operator), # of usages/ JBTD - Scope/Estimate/Resourcing etc' },
  { domain: 'Analytics & Reporting', target: 'Oct 2026', name: 'Scoper/Seller: my deals, estimate status, staleness alerts' },
  { domain: 'Analytics & Reporting', target: 'Oct 2026', name: 'Field Advisors: feedback tracker, QA triage pipeline, pilot adoption metrics' },
  { domain: 'Analytics & Reporting', target: 'Oct 2026', name: 'Adoption: tool usage rates, completion rates, time-to-estimate by scoper' },
  { domain: 'Analytics & Reporting', target: 'Nov 2026', name: 'Workforce: GDC blend actuals vs Everest benchmark, role utilization by grade, staffing demand forecast' },
  { domain: 'Analytics & Reporting', target: 'Nov 2026', name: 'Pricing: margin analysis by OU, contingency usage (applied vs consumed), rate card variance' },
  { domain: 'Analytics & Reporting', target: 'Nov 2026', name: 'Risk: risk score distribution by OU and commercial model, meeting/waive rates, override frequency' },
  { domain: 'Analytics & Reporting', target: 'Dec 2026', name: 'Leadership: portfolio dashboard (deal volume, win rate, margin, estimate accuracy, GDC %)' },
  { domain: 'Analytics & Reporting', target: 'Dec 2026', name: 'Leadership: OU benchmarks (actual vs estimated cost/timeline, quarterly CoE update)' },
  { domain: 'Analytics & Reporting', target: 'Dec 2026', name: 'Delivery: estimate-vs-actual variance (30 days post go-live, >5% root-caused)' },
  { domain: 'Analytics & Reporting', target: 'Dec 2026', name: 'Delivery: resource plan accuracy (staffed team vs recommended team)' },
  { domain: 'Feedback', target: 'Oct 2026', name: 'Ability to capture Feedback/JBTD, hosted in AWS or posted in Slack channel' },
  { domain: 'Feedback', target: 'Nov 2026', name: 'Feedback Hosted in AWS tables' }
];

// Duplicated (rather than imported) from FeedbackAnalysisPanel's normalize/tokenize so this file
// stays plain data with no dependency on the component layer — the two are kept in sync by hand
// since both change rarely and only together with a real matching-quality reason.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'was', 'be', 'it', 'this',
  'that', 'with', 'as', 'are', 'i', 'we', 'they', 'he', 'she', 'have', 'has', 'had', 'at', 'by',
  'from', 'into', 'about', 'so', 'but', 'if', 'than', 'then', 'there', 'when', 'which', 'who',
  'what', 'can', 'could', 'would', 'should', 'will', 'been', 'being', 'do', 'does', 'did', 'not',
  'tool', 'app', 'application', 'system', 'platform', 'solutioniq', 'product', 'feature',
  'features', 'area', 'section', 'currently', 'also', 'like', 'get', 'gets', 'getting',
  'per', 'auto', 'vs', 'ou'
]);

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(normalized) {
  return normalized.split(' ').filter(w => w && !STOPWORDS.has(w));
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function keywordRegex(kw) { return new RegExp('\\b' + escapeRegExp(kw).replace(/\\ /g, '\\s+') + '\\w*\\b', 'i'); }

DOMAINS.forEach(d => { d.regexes = d.keywords.map(keywordRegex); });

// Coverage-scored the same way as the Jira title matcher: what fraction of the item's own
// tokens show up in the feedback. Short item names (<=3 content words, e.g. "Custom Scope")
// require full containment rather than the normal 0.6 threshold — a 2-word title is too
// generic to trust on partial overlap, so it only counts when it's fully there.
//
// For longer items, the *fraction* requirement is capped at a 5-token title length rather than
// scaling forever — some roadmap line items run 10-13 words (e.g. "Fixed Capacity — scope-fit
// check (warns if scope exceeds 80% of capacity)"), and real feedback will never restate 60% of
// a 13-word title verbatim even when it's genuinely about that exact feature. Past 5 tokens the
// bar plateaus at a flat 3 shared tokens — still a real, non-coincidental signal, just not one
// that keeps getting harder to clear as the title gets longer.
const ITEM_MATCH_COVERAGE = 0.6;
const ITEM_MIN_SHARED_TOKENS = 2;
const ITEM_SHORT_TITLE_TOKENS = 3;
const ITEM_COVERAGE_LENGTH_CAP = 6;

// Deduplicated — a repeated word in the item's own title (e.g. "Advisory Only deal path (Deal
// type selection (Advisory Only / Implementation Only / Both)" repeats "advisory"/"only"/"deal")
// must only count once per match, or a single common word appearing in the feedback would rack
// up multiple "shared" hits against its own repeats and clear the bar on no real signal.
NEAR_TERM_ITEMS.forEach(i => { i.tokens = Array.from(new Set(tokenize(normalize(i.name)))); });

// Returns the best-matching near-term roadmap line item (if any), else falls back to a
// domain-level match, else null if this feedback doesn't clearly touch a roadmapped area.
function matchRoadmap(rawText) {
  if (!rawText) return null;
  const feedbackTokens = new Set(tokenize(normalize(rawText)));

  let best = null;
  NEAR_TERM_ITEMS.forEach(item => {
    const len = item.tokens.length;
    if (len < ITEM_MIN_SHARED_TOKENS) return;
    let shared = 0;
    item.tokens.forEach(t => { if (feedbackTokens.has(t)) shared++; });
    const coverage = shared / len;
    const requiredShared = len <= ITEM_SHORT_TITLE_TOKENS
      ? len
      : Math.max(ITEM_MIN_SHARED_TOKENS, Math.ceil(Math.min(len, ITEM_COVERAGE_LENGTH_CAP) * ITEM_MATCH_COVERAGE));
    if (shared >= requiredShared) {
      if (!best || coverage > best.coverage) best = { item, coverage };
    }
  });
  if (best) return { level: 'item', name: best.item.name, target: best.item.target };

  const scored = DOMAINS.map(d => ({ d, score: d.regexes.filter(re => re.test(rawText)).length }));
  const highest = scored.reduce((a, b) => (b.score > a.score ? b : a), { score: 0 });
  if (highest.score === 0) return null;
  return { level: 'domain', name: highest.d.name, target: null };
}

export { DOMAINS, NEAR_TERM_ITEMS, matchRoadmap };
