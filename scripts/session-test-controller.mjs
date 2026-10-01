import { spawnSync } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { join } from 'node:path';

function verifyCapability(secret, authorization, version) {
  if (!authorization?.startsWith('Bearer ')) return null;
  const parts = authorization.slice(7).split('.');
  if (parts.length !== 3 || parts[0] !== version) return null;
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  let actual;
  try { actual = Buffer.from(parts[2], 'base64url'); }
  catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
      || claims.iat > now + 120 || claims.exp <= now || claims.exp <= claims.iat
      || claims.exp - claims.iat > (['v1', 'v2'].includes(version) ? 600 : 60)
      || typeof claims.owner_id !== 'string' || !claims.owner_id) return null;
    return claims;
  } catch { return null; }
}

function send(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

// This server exercises browser -> real API -> authenticated HTTPS session/vault protocols.
// It is deliberately not a Kubernetes gateway, Forgejo workspace, or Pi model.
export async function startSessionTestController(directory, secret) {
  const certificate = join(directory, 'session-test.crt');
  const privateKey = join(directory, 'session-test.key');
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', privateKey, '-out', certificate, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'pipe', timeout: 15000 });
  if (generated.status !== 0) throw new Error('Could not generate isolated session test certificate');
  const turns = new Map();
  const vaultObjects = new Map();
  const workspaces = new Map();
  const server = https.createServer({
    key: await readFile(privateKey), cert: await readFile(certificate),
  }, async (req, res) => {
    const workspaceRoute = /^\/v1\/sessions\/(notes|note|note\/move|search|graph)$/.test(req.url ?? '');
    if (workspaceRoute) {
      const allowedOrigin = 'http://127.0.0.1:1423';
      if (req.headers.origin !== allowedOrigin) return send(res, 403, { error: { id: 'forbidden_origin' } });
      const cors = {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
        Vary: 'Origin',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'Cache-Control': 'no-store' });
        return res.end();
      }
      const claims = verifyCapability(secret, req.headers.authorization, 'v2');
      if (!claims || claims.scope !== 'workspace') return send(res, 401, { error: { id: 'unauthorized' } }, cors);
      let input;
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > (96 << 10)) return send(res, 413, { error: { id: 'too_large' } }, cors);
        }
        input = JSON.parse(body);
      } catch {
        return send(res, 400, { error: { id: 'invalid_request' } }, cors);
      }
      if (input.version !== 'session.v1' || !/^[a-f0-9]{32}$/.test(input.session_id)
        || !/^[a-f0-9]{32}$/.test(input.entry_id)
        || !['study-agent', 'study-guide'].includes(input.profile)
        || ['owner_id', 'session_id', 'entry_id', 'profile'].some(key => input[key] !== claims[key])) {
        return send(res, 401, { error: { id: 'unauthorized' } }, cors);
      }
      const key = `${claims.owner_id}:${claims.session_id}`;
      let workspace = workspaces.get(key);
      if (!workspace) {
        workspace = { revision: createHash('sha1').update(`initial:${key}`).digest('hex'), notes: new Map() };
        workspaces.set(key, workspace);
      }
      const result = (status, value) => send(res, status, { version: 'session.v1', ...value }, cors);
      if (req.url === '/v1/sessions/notes' && req.method === 'POST') {
        return result(200, { paths: [...workspace.notes.keys()].sort(), revision: workspace.revision });
      }
      if (req.url === '/v1/sessions/search' && req.method === 'POST') {
        if (typeof input.query !== 'string' || !input.query.trim() || Buffer.byteLength(input.query) > 128) {
          return result(400, { error: { id: 'invalid_request' } });
        }
        const query = input.query.toLowerCase();
        const hits = [...workspace.notes.entries()]
          .filter(([path, content]) => path.toLowerCase().includes(query) || content.toLowerCase().includes(query))
          .slice(0, 20).map(([path, content]) => ({ path, snippet: [...content].slice(0, 160).join(''), score: 1 }));
        return result(200, { hits, revision: workspace.revision });
      }
      if (req.url === '/v1/sessions/graph' && req.method === 'POST') {
        return result(200, { nodes: [...workspace.notes.keys()].sort(), edges: [], revision: workspace.revision });
      }
      if (req.url === '/v1/sessions/note' && typeof input.path === 'string'
        && /^[^./][^\0\r\n\\:]*\.md$/i.test(input.path) && !input.path.split('/').some(part => !part || part.startsWith('.'))) {
        if (req.method === 'POST') {
          const content = workspace.notes.get(input.path);
          return content === undefined
            ? result(404, { error: { id: 'note_not_found' } })
            : result(200, { path: input.path, content, revision: workspace.revision });
        }
        if (!['PUT', 'PATCH'].includes(req.method)) return result(405, { error: { id: 'method_not_allowed' } });
        if (!/^[a-f0-9]{40}$/.test(input.expected_revision) || typeof input.content !== 'string'
          || Buffer.byteLength(input.content) > (80 << 10)) return result(400, { error: { id: 'invalid_request' } });
        const exists = workspace.notes.has(input.path);
        if (input.expected_revision !== workspace.revision || exists !== (req.method === 'PATCH')) {
          return result(409, { error: { id: 'revision_conflict' } });
        }
        workspace.notes.set(input.path, input.content);
        workspace.revision = createHash('sha1').update(`${workspace.revision}:${input.path}:${input.content}`).digest('hex');
        return result(req.method === 'PUT' ? 201 : 200, { path: input.path, revision: workspace.revision });
      }
      return result(404, { error: { id: 'not_found' } });
    }
    const vaultPath = req.url?.match(/^\/v1\/vault\/objects\/([0-9a-f]{32})$/);
    const vaultStatus = req.url === '/v1/vault/status';
    const version = req.url === '/v1/quota' ? 'quota-v1' : vaultPath || vaultStatus ? 'vault-v1' : 'v1';
    const claims = verifyCapability(secret, req.headers.authorization, version);
    if (!claims) return send(res, 401, { error: { id: 'unauthorized' } });
    if (vaultStatus) {
      if (req.method !== 'GET') return send(res, 405, { error: { id: 'method_not_allowed' } });
      return send(res, 200, { configured: true });
    }
    if (vaultPath) {
      const key = `${claims.owner_id}:${vaultPath[1]}`;
      const saved = vaultObjects.get(key);
      if (req.method === 'GET') {
        if (!saved) return send(res, 404, { error: { id: 'vault_object_not_found' } });
        res.writeHead(200, { 'Content-Type': 'application/vnd.tjuclaw.sealed+json',
          'Cache-Control': 'no-store', ETag: `"${saved.sha}"` });
        return res.end(saved.body);
      }
      if (req.method === 'DELETE') {
        if (!/^"[0-9a-f]{40}"$/.test(req.headers['if-match'] ?? '') || req.headers['if-none-match']) {
          return send(res, 428, { error: { id: 'vault_revision_required' } });
        }
        if (!saved) return send(res, 404, { error: { id: 'vault_object_not_found' } });
        if (req.headers['if-match'] !== `"${saved.sha}"`) {
          return send(res, 409, { error: { id: 'vault_revision_conflict' } });
        }
        vaultObjects.delete(key);
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (req.method !== 'PUT') return send(res, 405, { error: { id: 'method_not_allowed' } });
      if (req.headers['content-type'] !== 'application/vnd.tjuclaw.sealed+json') {
        return send(res, 415, { error: { id: 'unsupported_media_type' } });
      }
      const none = req.headers['if-none-match'];
      const match = req.headers['if-match'];
      if (none !== '*' && !/^"[0-9a-f]{40}"$/.test(match ?? '') ||
          none === '*' && Boolean(match)) return send(res, 428, { error: { id: 'vault_revision_required' } });
      let body = '';
      try {
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > (144 << 10)) return send(res, 413, { error: { id: 'request_too_large' } });
        }
        const object = JSON.parse(body);
        if (!object || Object.keys(object).sort().join() !== 'ciphertext,nonce,salt,version' ||
            object.version !== 1 || !['salt', 'nonce', 'ciphertext'].every(field => typeof object[field] === 'string') ||
            !['salt', 'nonce', 'ciphertext'].every(field => /^[A-Za-z0-9_-]+$/.test(object[field])) ||
            Buffer.from(object.salt, 'base64url').length !== 16 ||
            Buffer.from(object.nonce, 'base64url').length !== 12 ||
            Buffer.from(object.ciphertext, 'base64url').length < 16 ||
            Buffer.from(object.ciphertext, 'base64url').length > (96 << 10)) {
          return send(res, 400, { error: { id: 'invalid_sealed_object' } });
        }
      } catch {
        return send(res, 400, { error: { id: 'invalid_sealed_object' } });
      }
      if (saved ? match !== `"${saved.sha}"` : none !== '*') {
        return send(res, 409, { error: { id: 'vault_revision_conflict' } });
      }
      const sha = createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex');
      vaultObjects.set(key, { sha, body });
      res.writeHead(saved ? 200 : 201, { 'Content-Type': 'application/json',
        'Cache-Control': 'no-store', ETag: `"${sha}"` });
      return res.end('{"ok":true}');
    }
    if (req.method === 'GET' && req.url === '/v1/quota') {
      return send(res, 200, { limit: 20, used: 0, remaining: 20 });
    }
    if (req.method !== 'POST' || !['/v1/sessions/ensure', '/v1/sessions/message'].includes(req.url)) {
      return send(res, 404, { error: { id: 'not_found' } });
    }
    let data = '';
    try {
      for await (const chunk of req) {
        data += chunk;
        if (data.length > (16 << 10)) return send(res, 413, { error: { id: 'too_large' } });
      }
      const input = JSON.parse(data);
      if (input.version !== 'session.v1' || !/^[a-f0-9]{32}$/.test(input.session_id)
        || !/^[a-f0-9]{32}$/.test(input.entry_id)
        || !['study-agent', 'study-guide'].includes(input.profile)
        || ['owner_id', 'session_id', 'entry_id', 'profile'].some(key => input[key] !== claims[key])) {
        return send(res, 403, { error: { id: 'forbidden' } });
      }
      const key = `${claims.owner_id}:${claims.session_id}`;
      if (req.url.endsWith('/ensure')) {
        return send(res, 200, { version: 'session.v1', ready: true });
      }
      // The signed Gateway prepares cold sessions within the message request.
      // Requiring a separate ensure here would enforce the old controller flow.
      if (!Number.isInteger(input.turn) || input.turn < 1 || input.turn > 100
        || typeof input.content !== 'string' || !input.content.trim()) {
        return send(res, 400, { error: { id: 'invalid_request' } });
      }
      const turnKey = `${key}:${input.turn}`;
      const previous = turns.get(turnKey);
      if (previous && previous.content !== input.content) return send(res, 409, { error: { id: 'turn_conflict' } });
      const reply = previous?.reply ?? `隔离测试回复：${input.content}`;
      turns.set(turnKey, { content: input.content, reply });
      return send(res, 200, { version: 'session.v1', turn: input.turn, content: reply });
    } catch {
      return send(res, 400, { error: { id: 'invalid_request' } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `https://127.0.0.1:${server.address().port}`,
    certificate,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
