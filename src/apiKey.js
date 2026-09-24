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

// Shared key for the Feedback Analyzer's automatic AI dedup, baked into the production build
// (see .env.local / Heroku config var REACT_APP_FEEDBACK_ANALYZER_AI_KEY) so that feature works
// for everyone without each person entering their own personal gateway key.
const FEEDBACK_ANALYZER_AI_KEY = process.env.REACT_APP_FEEDBACK_ANALYZER_AI_KEY || '';

// The gateway above is only reachable from inside the Salesforce corporate network/VPN. This app
// is Salesforce-employee-only, so every user's own browser is on that network even when the app
// itself is hosted publicly (e.g. Heroku) — calling the gateway straight from the browser, rather
// than proxying through the Heroku server, is what makes this work in production as well as local
// dev (a Heroku dyno has no route to the gateway at all, so a server-side proxy call never can).
async function callGateway(key, prompt, model, maxTokens) {
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

export async function callAI(prompt, model, maxTokens) {
  return callGateway(getApiKey(), prompt, model, maxTokens);
}

export async function callFeedbackAI(prompt, maxTokens) {
  return callGateway(getApiKey() || FEEDBACK_ANALYZER_AI_KEY, prompt, 'us.anthropic.claude-sonnet-4-6', maxTokens);
}
