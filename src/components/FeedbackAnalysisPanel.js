import React, { useMemo, useState } from 'react';

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
  'what', 'can', 'could', 'would', 'should', 'will', 'been', 'being', 'do', 'does', 'did', 'not'
]);

// Two-pass dedup: exact-normalized match first (catches copy/paste or repeated entries),
// then fuzzy word-overlap for longer entries only — short entries are too noisy to fuzzy-match reliably.
const JACCARD_THRESHOLD = 0.6;
const MIN_SHARED_TOKENS = 2;
const MIN_TOKENS_FOR_FUZZY = 4;

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
  return normalized.split(' ').filter(w => w && !STOPWORDS.has(w));
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

  // Default ambiguous/no-signal feedback to Negative — this tracker logs field friction by
  // design, so unlabeled short notes are far more likely to be a pain point than praise.
  return score > 0 ? 'Positive' : 'Negative';
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
    lead: 'Daniel Furry', members: ['Vaibhav Kumar', 'Deepak Kumar', 'Aisha Sohail', 'Uujwal Grade'],
    keywords: ['scop', 'out of scope', 'out-of-scope', 'assumption', 'marketing cloud', 'confirmed scope', 'assumed scope']
  },
  {
    key: 'uiux', name: 'UI/UX', focus: 'Scenario Lab design alternatives, home page direction',
    lead: 'Mariella', members: [],
    keywords: ['design', 'home page', 'homepage', 'landing page', 'layout', 'navigation', 'visual design', 'user interface', 'font', 'color', 'button placement', 'look and feel', 'floating menu', 'panel', 'screen space', 'scenario lab']
  }
];

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

function dedupeFeedback(feedback) {
  const items = feedback.map(f => {
    const text = combinedText(f) || f.providerName || '';
    const norm = normalize(text);
    const tokens = new Set(tokenize(norm));
    return { f, text, norm, tokens };
  });

  const groups = []; // { normKey, representative, tokens, members: [item] }

  items.forEach(item => {
    // Pass 1: exact match on normalized text
    const exact = groups.find(g => g.normKey === item.norm);
    if (exact) { exact.members.push(item); return; }

    // Pass 2: fuzzy word-overlap match, only for longer entries
    if (item.tokens.size >= MIN_TOKENS_FOR_FUZZY) {
      const fuzzy = groups.find(g => {
        if (g.tokens.size < MIN_TOKENS_FOR_FUZZY) return false;
        const { ratio, shared } = jaccard(item.tokens, g.tokens);
        return ratio >= JACCARD_THRESHOLD && shared >= MIN_SHARED_TOKENS;
      });
      if (fuzzy) { fuzzy.members.push(item); return; }
    }

    groups.push({ normKey: item.norm, tokens: item.tokens, members: [item] });
  });

  return groups.map(g => {
    // Representative text: the longest original entry in the group (most descriptive)
    const rep = g.members.reduce((best, cur) => cur.text.length > best.text.length ? cur : best, g.members[0]);
    const sentiments = g.members.map(m => classifySentiment(m.text));
    const positiveCount = sentiments.filter(s => s === 'Positive').length;
    const sentiment = positiveCount * 2 > sentiments.length ? 'Positive' : 'Negative';
    const sourceIds = g.members.map(m => m.f.id);
    return {
      // Stable key for this cluster so a status note survives re-render/re-dedup as long
      // as the same set of underlying feedback IDs groups together.
      groupKey: sourceIds.slice().sort().join(','),
      summary: rep.text || '(no details)',
      sentiment,
      sourceIds,
      pods: sentiment === 'Negative' ? routeToPod(rep.text) : []
    };
  }).sort((a, b) => b.sourceIds.length - a.sourceIds.length);
}

export { dedupeFeedback, PODS, feedbackDetailText };

export default function FeedbackAnalysisPanel({ feedback, initiative }) {
  const [expandedGroup, setExpandedGroup] = useState(null);

  const feedbackById = useMemo(() => new Map(feedback.map(f => [f.id, f])), [feedback]);
  const groups = useMemo(() => dedupeFeedback(feedback), [feedback]);

  const negative = groups.filter(g => g.sentiment === 'Negative');
  const positive = groups.filter(g => g.sentiment === 'Positive');

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#032D60' }}>Feedback Analysis</h2>
        <p style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
          {feedback.length} field input{feedback.length !== 1 ? 's' : ''} for {initiative.name}, deduplicated by matching wording and split into positive and negative feedback. Negative feedback is tagged with the pod to notify. Computed locally — no AI involved.
        </p>
      </div>

      {feedback.length === 0 ? (
        <div style={styles.empty}>No feedback logged for this initiative yet.</div>
      ) : (
        <div>
          <div style={styles.summaryBar}>
            <span><strong>{groups.length}</strong> unique point{groups.length !== 1 ? 's' : ''} after dedup</span>
            <span style={{ color: '#9ca3af' }}>·</span>
            <span style={{ color: '#dc2626' }}>{negative.length} negative</span>
            <span style={{ color: '#9ca3af' }}>·</span>
            <span style={{ color: '#059669' }}>{positive.length} positive</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <GroupColumn
              title="🔴 Negative Feedback"
              subtitle="Needs improvement"
              groupsList={negative}
              feedbackById={feedbackById}
              expandedGroup={expandedGroup}
              setExpandedGroup={setExpandedGroup}
              accent="#dc2626"
              keyPrefix="neg"
            />
            <GroupColumn
              title="🟢 Positive Feedback"
              subtitle="Working well"
              groupsList={positive}
              feedbackById={feedbackById}
              expandedGroup={expandedGroup}
              setExpandedGroup={setExpandedGroup}
              accent="#059669"
              keyPrefix="pos"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function GroupColumn({ title, subtitle, groupsList, feedbackById, expandedGroup, setExpandedGroup, accent, keyPrefix }) {
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
            const isOpen = expandedGroup === key;
            return (
              <div key={key} style={{ ...styles.card, borderLeft: `4px solid ${accent}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 14, color: '#1f2937', lineHeight: 1.5, marginBottom: 6 }}>{g.summary}</p>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: '#6b7280' }}>
                      <span>📣 {matched.length} report{matched.length !== 1 ? 's' : ''}</span>
                      {regions.length > 0 && <span>🌍 {regions.join(', ')}</span>}
                    </div>
                    {keyPrefix === 'neg' && <PodBadges pods={g.pods} />}
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
  sourceRow: { fontSize: 13, padding: '6px 0', borderBottom: '1px solid #f3f4f6' }
};
