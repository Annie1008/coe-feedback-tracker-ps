const STORAGE_KEY = 'coe_gateway_key';

export function getApiKey() {
  return localStorage.getItem(STORAGE_KEY) || '';
}

export function setApiKey(key) {
  localStorage.setItem(STORAGE_KEY, key.trim());
}

export function clearApiKey() {
  localStorage.removeItem(STORAGE_KEY);
}

const GATEWAY_URL = 'https://eng-ai-model-gateway.sfproxy.devx-preprod.aws-esvc1-useast2.aws.sfdc.cl/v1/messages';

export async function callAI(prompt, model, maxTokens) {
  const key = getApiKey();
  if (!key) throw new Error('NO_KEY');

  const res = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'us.anthropic.claude-sonnet-4-6',
      max_tokens: maxTokens || 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) throw new Error(`AI request failed: ${res.status}`);
  const json = await res.json();
  return json.content?.[0]?.text || '';
}

const API_BASE = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001';

// Feedback Analyzer's AI dedup goes through the server (not the gateway directly) so it can use
// a dedicated key configured server-side (FEEDBACK_ANALYZER_AI_KEY) — this feature just works
// for everyone, no one has to open the key icon and paste in their own personal key for it.
export async function callFeedbackAI(prompt, maxTokens) {
  const res = await fetch(`${API_BASE}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'us.anthropic.claude-sonnet-4-6',
      max_tokens: maxTokens || 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) throw new Error(`AI request failed: ${res.status}`);
  const json = await res.json();
  return json.content?.[0]?.text || '';
}
