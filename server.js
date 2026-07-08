const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const IS_PROD = process.env.NODE_ENV === 'production';
const AI_BASE_URL = 'https://eng-ai-model-gateway.sfproxy.devx-preprod.aws-esvc1-useast2.aws.sfdc.cl';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-api-key');
}

function serveStatic(res, filePath) {
  const full = path.join(__dirname, 'build', filePath);
  const target = fs.existsSync(full) ? full : path.join(__dirname, 'build', 'index.html');
  const ext = path.extname(target);
  const mime = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
  }[ext] || 'text/plain';
  try {
    const content = fs.readFileSync(target);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // ── AI proxy — forwards user's own key to the gateway ───────
  if (pathname === '/api/ai') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const userKey = req.headers['x-user-api-key'];
      if (!userKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No API key provided. Set your LLM Gateway key in the app.' }));
        return;
      }

      const target = new URL('/v1/messages', AI_BASE_URL);
      const options = {
        hostname: target.hostname,
        path: target.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': userKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const proxyReq = https.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', err => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error: ' + err.message }));
      });
      proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  // ── Serve React build in production ─────────────────────────
  if (IS_PROD) {
    if (pathname.startsWith('/static/') || pathname.includes('.')) {
      serveStatic(res, pathname);
    } else {
      serveStatic(res, 'index.html');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT} (${IS_PROD ? 'production' : 'development'})`);
});
