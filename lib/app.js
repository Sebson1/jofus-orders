// Tiny Express-style router on Node's built-in http module – no dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

function createApp({ staticDir, jsonLimit = 25 * 1024 * 1024, rawPaths = [] } = {}) {
  const routes = [];

  function add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handlers });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > jsonLimit) { reject(new Error('Payload too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function decorate(req, res) {
    const url = new URL(req.url, 'http://x');
    req.path = url.pathname; req.query = Object.fromEntries(url.searchParams); req.params = {};
    res.status = c => { res.statusCode = c; return res; };
    res.json = o => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };
    res.sendStatus = c => { res.statusCode = c; res.end(http.STATUS_CODES[c] || ''); };
    res.redirect = u => { res.statusCode = 302; res.setHeader('Location', u); res.end(); };
    res.send = s => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(s); };
  }

  function serveStatic(req, res) {
    if (!staticDir || !['GET', 'HEAD'].includes(req.method)) return false;
    let p = decodeURIComponent(req.path);
    if (p.endsWith('/')) p += 'index.html';
    const candidates = [p, p + '.html'];
    for (const c of candidates) {
      const file = path.normalize(path.join(staticDir, c));
      if (!file.startsWith(staticDir)) return false;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Cache-Control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
        if (req.method === 'HEAD') return res.end(), true;
        fs.createReadStream(file).pipe(res); return true;
      }
    }
    return false;
  }

  async function handle(req, res) {
    decorate(req, res);
    try {
      if (serveStatic(req, res)) return;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = req.path.match(r.re); if (!m) continue;
        r.keys.forEach((k, i) => req.params[k] = decodeURIComponent(m[i + 1]));
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
          const raw = await readBody(req);
          if (rawPaths.includes(req.path)) req.body = raw;
          else { try { req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }
        }
        let i = 0;
        const next = async (err) => {
          if (err) throw err;
          const h = r.handlers[i++]; if (!h) return;
          await h(req, res, next);
        };
        await next();
        return;
      }
      res.status(404).json({ error: 'Not found' });
    } catch (e) {
      console.error(req.method, req.path, e);
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    }
  }

  const app = { get: (p, ...h) => add('GET', p, ...h), post: (p, ...h) => add('POST', p, ...h), put: (p, ...h) => add('PUT', p, ...h), delete: (p, ...h) => add('DELETE', p, ...h), listen: (port, cb) => http.createServer(handle).listen(port, cb) };
  return app;
}

module.exports = { createApp };
