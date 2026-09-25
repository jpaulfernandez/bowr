// Serves .vercel/output locally with the same routes/headers as production.
// Usage: pnpm --filter @bowr/app serve:web [port]
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = join(dirname(fileURLToPath(import.meta.url)), '..', '.vercel', 'output');
const staticDir = join(output, 'static');
const { routes } = JSON.parse(readFileSync(join(output, 'config.json'), 'utf8'));
const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
};

function fileFor(pathname) {
  const candidate = normalize(join(staticDir, decodeURIComponent(pathname)));
  if (!candidate.startsWith(staticDir)) return null;
  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
}

createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const headers = {};
  let afterFilesystem = false;
  for (const route of routes) {
    if (route.handle === 'filesystem') {
      const file = fileFor(pathname);
      if (file) return send(res, 200, headers, file);
      afterFilesystem = true;
      continue;
    }
    if (!new RegExp(`^${route.src}$`).test(pathname)) continue;
    if (route.headers) Object.assign(headers, route.headers);
    if (route.status) return send(res, route.status, headers, null);
    if (route.dest && afterFilesystem) return send(res, 200, headers, fileFor(route.dest));
    if (!route.continue) break;
  }
  return send(res, 404, headers, null);
}).listen(port, () => console.log(`Serving ${staticDir} on http://localhost:${port}`));

function send(res, status, headers, file) {
  if (!file) {
    res.writeHead(status, headers);
    return res.end();
  }
  res.writeHead(status, { ...headers, 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}
