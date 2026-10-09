// Static server that mimics GitHub Pages: the repo root served under /WMCoach/.
// Usage: npm run serve [-- --port 8080]
// The e2e test imports startServer() and can override the served version to test updates.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

export function startServer({ port = 8080, prefix = '/WMCoach/', root = fileURLToPath(new URL('../', import.meta.url)) } = {}) {
  const state = { versionOverride: null };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(url.pathname === '/' ? 302 : 404, url.pathname === '/' ? { Location: prefix } : {});
      res.end();
      return;
    }
    let rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root)) || rel.startsWith('.git') || rel.startsWith('node_modules')) {
      res.writeHead(404); res.end(); return;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      let body = await readFile(file);
      if (state.versionOverride && (rel === 'sw.js' || rel === 'app/version.js')) {
        body = Buffer.from(body.toString('utf8').replace(/'\d+\.\d+\.\d+[^']*'/, `'${state.versionOverride}'`));
      }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, state, url: `http://localhost:${port}${prefix}` })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--port');
  const { url } = await startServer({ port: i > 0 ? Number(process.argv[i + 1]) : 8080 });
  console.log(`Serving ${url}`);
}
