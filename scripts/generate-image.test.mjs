import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRequestBody, decodeImageResponse, parseArgs, resolveConfig, validateImageBytes } from './generate-image.mjs';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const env = { IMAGE_API_BASE_URL: 'https://example.invalid/v1', IMAGE_API_KEY: 'test-key' };

test('parses image task arguments', () => {
  assert.deepEqual(parseArgs(['--prompt', 'draw it', '--output', 'out.png']), { prompt: 'draw it', output: 'out.png' });
  assert.throws(() => parseArgs(['--unknown', 'x']), /Unknown option/);
});

test('resolves safe defaults and preserves configured base paths', () => {
  const config = resolveConfig(env, { prompt: 'architecture', output: 'out.png' });
  assert.equal(config.url, 'https://example.invalid/v1/images/generations');
  assert.equal(config.model, 'gpt-image-2.5-flare');
  assert.deepEqual(buildRequestBody(config), {
    model: 'gpt-image-2.5-flare', prompt: 'architecture', n: 1,
    size: '1536x1024', quality: 'medium', output_format: 'png',
  });
});

test('rejects missing configuration and malformed image responses', () => {
  assert.throws(() => resolveConfig({}, { prompt: 'x', output: 'x.png' }), /IMAGE_API_BASE_URL/);
  assert.throws(() => resolveConfig({ IMAGE_API_BASE_URL: env.IMAGE_API_BASE_URL }, { prompt: 'x', output: 'x.png' }), /IMAGE_API_KEY/);
  assert.throws(() => decodeImageResponse({ data: [{ url: 'https://example.invalid/x' }] }, 'png'), /b64_json/);
  assert.deepEqual(validateImageBytes(png, 'png'), png);
  assert.throws(() => validateImageBytes(Buffer.from('nope'), 'png'), /valid png/);
});
