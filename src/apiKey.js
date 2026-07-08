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

const API_BASE = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001';

export async function callAI(prompt, model) {
  const key = getApiKey();
  if (!key) throw new Error('NO_KEY');

  const res = await fetch(`${API_BASE}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-api-key': key },
    body: JSON.stringify({
      model: model || process.env.REACT_APP_AI_MODEL || 'us.anthropic.claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) throw new Error(`AI request failed: ${res.status}`);
  const json = await res.json();
  return json.content?.[0]?.text || '';
}
