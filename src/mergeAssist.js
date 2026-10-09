const MAX_TEXT = 800;
const MAX_GROUPS = 20;
const BATCH_SIZE = 5;

function stripJsonFences(text) {
  return String(text || '').replace(/```(?:json)?/gi, '').trim();
}

export function extractFinalJsonValue(text) {
  const trimmed = stripJsonFences(text);
  const candidates = [];
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch !== '[' && ch !== '{') { i += 1; continue; }
    const openChar = ch;
    const closeChar = openChar === '[' ? ']' : '}';
    let depth = 0, inString = false, escape = false, j = i;
    for (; j < trimmed.length; j += 1) {
      const c = trimmed[j];
      if (inString) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === openChar) depth += 1;
      else if (c === closeChar) {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    try { candidates.push(JSON.parse(trimmed.slice(i, j + 1))); } catch { /* skip */ }
    i = j + 1;
  }
  if (!candidates.length) throw new Error('No valid JSON found in AI response');
  return candidates[candidates.length - 1];
}

export function clipCanonicalText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

export function buildMergeAssistPrompt(groups) {
  const listing = groups.map((group, index) => {
    const members = (group.members || []).map((member, memberIndex) => (
      `  M${memberIndex} id=${member.id} submissions=${member.submissionCount || 0}: ${clipCanonicalText(member.text || member.title)}`
    )).join('\n');
    return `GROUP ${index} id=${group.id} members=${(group.members || []).length}\n${members}`;
  }).join('\n\n');
  return `You are assisting a human reviewer who must decide whether lexically similar field-feedback records are the same user need.

Rules:
- same_need means every member asks for the same deliverable outcome, not just similar wording.
- adjacent_need means related but independently deliverable. Prefer this over same_need when unsure.
- Never invent member ids. suggestedWinnerId must be one of the listed member ids, or null.
- Do not recommend merging just because texts share a product area.
- Keep reason under 160 characters.

GROUPS:
${listing}

Respond with ONLY a JSON array, one object per GROUP in the same order:
[{"groupIndex":0,"verdict":"same_need"|"adjacent_need","suggestedWinnerId":"<member id>"|null,"confidence":0.0-1.0,"reason":"<short reason>"}]`;
}

export function normalizeAssistItem(item, group) {
  const memberIds = new Set((group?.members || []).map(member => String(member.id)));
  const verdict = item?.verdict === 'same_need' ? 'same_need' : 'adjacent_need';
  const suggestedWinnerId = memberIds.has(String(item?.suggestedWinnerId || '')) ? String(item.suggestedWinnerId) : null;
  const confidence = Number(item?.confidence);
  return {
    verdict,
    suggestedWinnerId: verdict === 'same_need' ? suggestedWinnerId : null,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reason: typeof item?.reason === 'string' ? item.reason.trim().slice(0, 200) : ''
  };
}

function emptyAssist(error) {
  return { verdict: 'adjacent_need', suggestedWinnerId: null, confidence: 0, reason: '', error };
}

export async function assistMergeGroups(groups, { callAI } = {}) {
  if (!callAI) {
    const { callFeedbackAI } = await import('./apiKey');
    callAI = callFeedbackAI;
  }
  const targets = (groups || []).slice(0, MAX_GROUPS);
  const assists = new Array(targets.length);
  for (let start = 0; start < targets.length; start += BATCH_SIZE) {
    const batch = targets.slice(start, start + BATCH_SIZE);
    try {
      const parsed = extractFinalJsonValue(await callAI(buildMergeAssistPrompt(batch), 2048));
      const rows = Array.isArray(parsed) ? parsed : [];
      batch.forEach((group, offset) => {
        const item = rows.find(row => Number(row?.groupIndex) === offset) || rows[offset];
        assists[start + offset] = item ? normalizeAssistItem(item, group) : emptyAssist('missing');
      });
    } catch (error) {
      batch.forEach((_, offset) => { assists[start + offset] = emptyAssist(error.message || 'AI assist failed'); });
    }
  }
  return Object.fromEntries(targets.map((group, index) => [group.id, assists[index]]));
}
