import assert from 'node:assert/strict';

function port(name, fallback) {
  const value = Number(process.env[name] || fallback);
  assert.ok(Number.isInteger(value) && value > 0 && value <= 65535, `Invalid ${name}`);
  return value;
}

const web = `http://127.0.0.1:${port('WEB_PORT', 8088)}`;
const api = `http://127.0.0.1:${port('API_PORT', 8080)}`;
const get = (url, options) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });

for (const url of [`${api}/healthz`, `${web}/api/healthz`]) {
  const response = await get(url);
  assert.equal(response.status, 200, url);
  assert.deepEqual(await response.json(), { status: 'ok' });
}
assert.equal((await get(`${api}/healthz`, { method: 'POST' })).status, 405);
assert.equal((await get(`${api}/unknown`)).status, 404);
const response = await get(web);
assert.equal(response.status, 200);
assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
const html = await response.text();
assert.match(html, /<title>TJUClaw<\/title>/);
const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)];
assert.ok(assets.length >= 2, 'Expected JavaScript and CSS assets');
for (const [, asset] of assets) {
  const url = new URL(asset, web);
  assert.equal(url.origin, web, 'Build must not fetch third-party assets');
  assert.equal((await get(url)).status, 200, asset);
}
assert.equal((await get(`${web}/assets/missing.js`)).status, 404);
assert.equal(await (await get(`${web}/.env.local`)).text(), html, 'Private environment file must not be served');
console.log('Compose smoke passed: API, reverse proxy, Web assets, CSP and private-file boundary.');
