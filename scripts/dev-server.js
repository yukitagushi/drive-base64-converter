const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const handler = require('../api/file-stores.js');

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const PORT = Number(process.env.PORT || 3000);

function attachResponseHelpers(res) {
  res.status = function status(statusCode) {
    this.statusCode = statusCode;
    return this;
  };
  res.json = function json(body) {
    this.setHeader('Content-Type', 'application/json; charset=utf-8');
    this.end(JSON.stringify(body));
  };
  return res;
}

async function serveStatic(res, filePath) {
  try {
    const absPath = path.join(PUBLIC_DIR, filePath);
    const data = await fs.readFile(absPath);
    const ext = path.extname(absPath).toLowerCase();
    const type =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js'
          ? 'application/javascript; charset=utf-8'
          : 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.end(data);
  } catch (error) {
    res.statusCode = 404;
    res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    void serveStatic(res, 'index.html');
    return;
  }

  if (url.pathname === '/app.js') {
    void serveStatic(res, 'app.js');
    return;
  }

  if (url.pathname === '/api/file-stores') {
    attachResponseHelpers(res);
    void handler(req, res);
    return;
  }

  res.statusCode = 404;
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Dev server running on http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
