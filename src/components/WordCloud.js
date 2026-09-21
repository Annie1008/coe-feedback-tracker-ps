import React, { useMemo } from 'react';
import { normalize, STOPWORDS } from './FeedbackAnalysisPanel';

// A cloud of single words ("scope", "resource", "estimate") tells you what topics come up but not
// why they're a problem. Extracting short multi-word phrases instead ("out of scope", "resource
// plan") keeps the original word order so the cloud reads as actual concepts, not just tags.
const MIN_PHRASE_LEN = 2;
const MAX_PHRASE_LEN = 5;
const MIN_OCCURRENCES = 3;
const MAX_PHRASES = 20;

// Filler words that carry no topic meaning but aren't in the shared dedup STOPWORDS (that list is
// tuned for match matching, not phrase readability) — kept local so they don't affect dedup.
const PHRASE_EXTRA_STOPWORDS = new Set(['even', 'though', 'also', 'well', 'really', 'actually', 'yet', 'me']);

// A phrase ending on a bare verb ("users need", "must haves include") is a clause cut off before
// its object — it names an action, not a concept, so it reads as an unfinished sentence.
const WEAK_ENDING = new Set([
  'need', 'needs', 'want', 'wants', 'wanted', 'include', 'includes', 'included',
  'define', 'defines', 'defined', 'add', 'adds', 'added', 'use', 'uses', 'used', 'using',
  'get', 'gets', 'got', 'take', 'takes', 'took', 'make', 'makes', 'made', 'allow', 'allows',
  'require', 'requires', 'provide', 'provides', 'has', 'have', 'had', 'do', 'does', 'did',
  'must', 'guide', 'guides'
]);

// Nouns abstract enough that pairing them with just one other word ("right side", "content
// information") doesn't stand on its own — they need the rest of the sentence to mean anything.
const ABSTRACT_ALONE = new Set(['content', 'information', 'functionality', 'logic', 'side']);

function splitClauses(text) {
  return String(text || '').split(/[.!?;\n]+/).map(c => c.trim()).filter(Boolean);
}

function containsPhrase(biggerWords, smallerWords) {
  for (let i = 0; i + smallerWords.length <= biggerWords.length; i++) {
    if (smallerWords.every((w, j) => biggerWords[i + j] === w)) return true;
  }
  return false;
}

// "scope element" and "scope elements" are the same concept split across two entries just
// because one submitter wrote it singular and another plural — fold the less common form into
// the more common one so a cloud slot isn't wasted on a near-duplicate.
function mergePlurals(counts) {
  const merged = new Map(counts);
  Array.from(merged.keys()).forEach(key => {
    const words = key.split(' ');
    const last = words[words.length - 1];
    if (last.length > 3 && last.endsWith('s')) {
      const singularKey = [...words.slice(0, -1), last.slice(0, -1)].join(' ');
      if (merged.has(singularKey) && merged.has(key)) {
        const pluralCount = merged.get(key);
        const singularCount = merged.get(singularKey);
        if (pluralCount >= singularCount) {
          merged.set(key, pluralCount + singularCount);
          merged.delete(singularKey);
        } else {
          merged.set(singularKey, pluralCount + singularCount);
          merged.delete(key);
        }
      }
    }
  });
  return merged;
}

function phraseFrequencies(texts) {
  let counts = new Map();
  texts.forEach(text => {
    splitClauses(text).forEach(clause => {
      const words = normalize(clause).split(' ').filter(Boolean);
      for (let n = MAX_PHRASE_LEN; n >= MIN_PHRASE_LEN; n--) {
        for (let i = 0; i + n <= words.length; i++) {
          const gram = words.slice(i, i + n);
          // Require real word boundaries: a phrase that starts/ends on a stopword ("the scope
          // of", "scope of the") is a sentence fragment, not a phrase.
          if (STOPWORDS.has(gram[0]) || STOPWORDS.has(gram[gram.length - 1])) continue;
          if (PHRASE_EXTRA_STOPWORDS.has(gram[0]) || PHRASE_EXTRA_STOPWORDS.has(gram[gram.length - 1])) continue;
          if (WEAK_ENDING.has(gram[gram.length - 1])) continue;
          if (gram.length === 2 && gram.some(w => ABSTRACT_ALONE.has(w))) continue;
          if (gram.some(w => /^\d+$/.test(w) || w.length < 2)) continue;
          const contentWords = gram.filter(w => !STOPWORDS.has(w) && !PHRASE_EXTRA_STOPWORDS.has(w));
          if (contentWords.length < 2) continue;
          const phrase = gram.join(' ');
          counts.set(phrase, (counts.get(phrase) || 0) + 1);
        }
      }
    });
  });

  counts = mergePlurals(counts);

  const candidates = Array.from(counts.entries())
    .filter(([, count]) => count >= MIN_OCCURRENCES)
    .map(([phrase, count]) => ({ phrase, count, words: phrase.split(' ') }));

  // Drop a shorter phrase when a longer candidate contains it with the exact same count — every
  // occurrence of the short one is really part of the longer, more specific phrase, so showing
  // both is redundant noise.
  const survivors = candidates.filter(c =>
    !candidates.some(other =>
      other.words.length > c.words.length &&
      other.count === c.count &&
      containsPhrase(other.words, c.words)
    )
  );

  // Longer phrases read as more complete concepts than bigrams at the same frequency, but bigrams
  // are structurally cheaper to rack up occurrences (any 3+ word phrase's count is bounded by its
  // sub-bigrams') — this bonus keeps the ranking from being dominated purely by phrase length.
  const scored = survivors.map(c => ({ ...c, score: c.count * (1 + 0.25 * (c.words.length - 2)) }));

  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_PHRASES);
}

// Muted, earthy tones so the cloud reads like a tag cloud rather than a heat map.
const COLORS = ['#5b6d33', '#8a5a2b', '#3f6b6b', '#6b4f3f', '#4f6d3f', '#7a5230', '#375a5a', '#5c4a30'];
// Small fixed set of gentle tilts, cycled by index — deterministic so the layout doesn't jitter
// on every re-render (Math.random() would reshuffle angles each time useMemo recomputes).
const ROTATIONS = [0, -6, 5, 0, -9, 7, 0, -4, 8, -7, 0, 6, -5];

export default function WordCloud({ texts, title }) {
  const phrases = useMemo(() => phraseFrequencies(texts), [texts]);
  const maxCount = phrases[0]?.count || 1;
  const minCount = phrases[phrases.length - 1]?.count || 1;

  function fontSize(count) {
    if (maxCount === minCount) return 22;
    const t = (count - minCount) / (maxCount - minCount);
    return Math.round(13 + t * 33); // 13px .. 46px
  }

  if (phrases.length === 0) {
    return <div style={styles.empty}>Not enough repeated phrasing to build a phrase cloud.</div>;
  }

  return (
    <div style={styles.box}>
      {title && <div style={styles.title}>{title}</div>}
      <div style={styles.cloud}>
        {phrases.map((p, idx) => (
          <span
            key={p.phrase}
            title={`"${p.phrase}" appears ${p.count} times`}
            style={{
              fontSize: fontSize(p.count),
              color: COLORS[idx % COLORS.length],
              fontWeight: p.count >= maxCount * 0.6 ? 700 : 500,
              lineHeight: 1.3,
              padding: '2px 6px',
              transform: `rotate(${ROTATIONS[idx % ROTATIONS.length]}deg)`,
              whiteSpace: 'nowrap',
              cursor: 'default'
            }}
          >
            {p.phrase}
          </span>
        ))}
      </div>
    </div>
  );
}

const styles = {
  box: { background: '#fdfcf9', border: '1px solid #e5e7eb', borderRadius: 8, padding: '22px 24px', marginBottom: 20 },
  title: { fontSize: 13, color: '#6b7280', marginBottom: 14, textAlign: 'center' },
  cloud: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: '2px 6px', textAlign: 'center' },
  empty: { background: '#fff', border: '1px dashed #e5e7eb', borderRadius: 8, padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }
};
