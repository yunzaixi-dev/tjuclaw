import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { viewports } from './src/audit-types.ts';

export function pngSize(data: Buffer) {
  if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Expected PNG');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export function localRequest(host: string | undefined, origin: string | undefined) {
  if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  return !origin || origin === `http://${host}`;
}

// Only explicit audit mode installs this server. Never expose Vite's raw /@fs
// route to the research tree; serve only indexed PNGs and descriptions.
export function auditServer(root: string): Plugin {
  const base = resolve(root);
  async function safeFile(path: string) {
    const absolute = await realpath(join(base, path));
    if (!absolute.startsWith(`${await realpath(base)}${sep}`)) throw new Error('Unsafe path');
    return absolute;
  }
  async function index() {
    return JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'));
  }
  return {
    name: 'local-audit-evidence',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (!url.pathname.startsWith('/__audit/')) return next();
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        if (!localRequest(req.headers.host, req.headers.origin)) {
          res.writeHead(403).end('Local requests only'); return;
        }
        try {
          const manifest = await index();
          if (url.pathname === '/__audit/manifest' && req.method === 'GET') {
            for (const screen of manifest.screens) {
              screen.reference = `/__audit/reference/${screen.id}`;
              screen.captures = {};
              for (const vp of viewports) {
                try {
                  const path = await safeFile(`runtime/${screen.id}/${vp.id}.png`);
                  const info = await stat(path);
                  const size = pngSize(await readFile(path));
                  screen.captures[vp.id] = { ...size, updatedAt: info.mtime.toISOString(),
                    url: `/__audit/runtime/${screen.id}/${vp.id}?v=${info.mtimeMs}` };
                } catch { /* An absent capture is an explicit audit gap. */ }
              }
              delete screen.file;
            }
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(manifest)); return;
          }
          const match = url.pathname.match(/^\/__audit\/(reference|description|runtime)\/(GB-\d{3})(?:\/(phone|compact|tablet|desktop))?$/);
          const screen = match && manifest.screens.find((item: { id: string }) => item.id === match[2]);
          if (!match || !screen) { res.writeHead(404).end('Unknown evidence'); return; }
          const [, kind, id, viewport] = match;
          if (kind === 'runtime' && !viewport) { res.writeHead(404).end(); return; }
          if (req.method === 'POST' && kind === 'runtime') {
            if (req.headers.origin !== `http://${req.headers.host}` || req.headers['content-type'] !== 'image/png') {
              res.writeHead(403).end('Same-origin PNG upload required'); return;
            }
            const chunks: Buffer[] = [];
            let length = 0;
            for await (const chunk of req) {
              length += chunk.length;
              if (length > 20 * 1024 * 1024) { res.writeHead(413).end('Maximum 20 MB'); return; }
              chunks.push(chunk);
            }
            const data = Buffer.concat(chunks);
            const size = pngSize(data);
            const expected = viewports.find(vp => vp.id === viewport)!;
            if (size.width !== expected.width || size.height !== expected.height) {
              res.writeHead(422).end(`Expected ${expected.width} x ${expected.height} PNG`); return;
            }
            const directory = join(base, 'runtime', id);
            await mkdir(directory, { recursive: true });
            await safeFile(`runtime/${id}`);
            const temp = join(directory, `${viewport}.${crypto.randomUUID()}.tmp`);
            await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
            await rename(temp, join(directory, `${viewport}.png`));
            res.writeHead(201).end('Stored locally'); return;
          }
          if (req.method !== 'GET') { res.writeHead(405).end(); return; }
          const relative = kind === 'reference' ? `reference/${screen.file}`
            : kind === 'description' ? `descriptions/${id}.md` : `runtime/${id}/${viewport}.png`;
          const path = await safeFile(relative);
          res.setHeader('Content-Type', kind === 'description' ? 'text/plain; charset=utf-8' : 'image/png');
          createReadStream(path).on('error', () => res.destroy()).pipe(res);
        } catch (error) {
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
          res.writeHead(missing ? 404 : 400).end(missing ? 'Evidence not indexed yet' : 'Invalid evidence request');
        }
      });
    },
  };
}
