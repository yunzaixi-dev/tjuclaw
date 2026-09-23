import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULTS = {
  path: '/images/generations',
  model: 'gpt-image-2.5-flare',
  size: '1536x1024',
  quality: 'medium',
  format: 'png',
  timeoutMs: 120000,
};

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help') return { help: true };
    if (!['--prompt', '--prompt-file', '--output', '--size', '--quality'].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    const key = option.slice(2).replace('-', '');
    args[key] = value;
    index += 1;
  }
  return args;
}

export function resolveConfig(env, args) {
  const baseUrl = env.IMAGE_API_BASE_URL;
  if (!baseUrl) throw new Error('IMAGE_API_BASE_URL is required');
  if (!env.IMAGE_API_KEY) throw new Error('IMAGE_API_KEY is required');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('IMAGE_API_BASE_URL must be an absolute URL');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('IMAGE_API_BASE_URL must be a safe HTTP(S) URL');
  }
  const prompt = args.prompt;
  if (!prompt || !prompt.trim()) throw new Error('A non-empty --prompt is required');
  if (prompt.length > 32000) throw new Error('--prompt is too long');
  const output = args.output;
  if (!output) throw new Error('--output is required');
  const size = args.size ?? env.IMAGE_SIZE ?? DEFAULTS.size;
  if (!/^\d{3,5}x\d{3,5}$/.test(size)) throw new Error('size must use WIDTHxHEIGHT format');
  const quality = args.quality ?? env.IMAGE_QUALITY ?? DEFAULTS.quality;
  if (!['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(quality)) {
    throw new Error('quality must be auto, low, medium, high, xhigh, or max');
  }
  const format = (env.IMAGE_OUTPUT_FORMAT ?? DEFAULTS.format).toLowerCase();
  if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error('IMAGE_OUTPUT_FORMAT must be png, jpeg, or webp');
  const timeoutMs = Number(env.IMAGE_TIMEOUT_MS ?? DEFAULTS.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error('IMAGE_TIMEOUT_MS must be at least 1000');
  const apiPath = env.IMAGE_API_PATH ?? DEFAULTS.path;
  const basePath = url.pathname.replace(/\/$/, '');
  const normalizedPath = `/${apiPath.replace(/^\/+/, '')}`;
  return {
    url: new URL(`${basePath}${normalizedPath}`, url).toString(),
    key: env.IMAGE_API_KEY,
    model: env.IMAGE_MODEL ?? DEFAULTS.model,
    prompt: prompt.trim(),
    output: resolve(output),
    size,
    quality,
    format,
    timeoutMs,
  };
}

export function buildRequestBody(config) {
  return {
    model: config.model,
    prompt: config.prompt,
    n: 1,
    size: config.size,
    quality: config.quality,
    output_format: config.format,
  };
}

function decodeBase64(value) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('response contained invalid base64 image data');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) throw new Error('response contained an empty image');
  return bytes;
}

export function validateImageBytes(bytes, format) {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
  const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  const valid = format === 'png' ? bytes.subarray(0, 8).equals(png) : format === 'jpeg' ? bytes.subarray(0, 3).equals(jpeg) : webp;
  if (!valid) throw new Error(`decoded image is not a valid ${format}`);
  return bytes;
}

export function decodeImageResponse(body, format) {
  const encoded = body?.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('response did not contain data[0].b64_json');
  }
  return validateImageBytes(decodeBase64(encoded), format);
}

export async function generateImage(config, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildRequestBody(config)),
      signal: controller.signal,
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`image API returned HTTP ${response.status} with invalid JSON`);
    }
    if (!response.ok) throw new Error(`image API returned HTTP ${response.status}`);
    const bytes = decodeImageResponse(body, config.format);
    await mkdir(dirname(config.output), { recursive: true });
    const temporary = `${config.output}.tmp-${process.pid}`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, config.output);
    } finally {
      await rm(temporary, { force: true });
    }
    return config.output;
  } finally {
    clearTimeout(timeout);
  }
}

function usage() {
  console.log('Usage: task image:generate -- --prompt "..." --output path/to/image.png');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) usage();
    else {
      const prompt = args.prompt ?? (args.promptfile ? await readFile(args.promptfile, 'utf8') : undefined);
      const output = resolveConfig(process.env, { ...args, prompt });
      const path = await generateImage(output);
      console.log(`Image written to ${path}`);
    }
  } catch (error) {
    console.error(`Image generation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}
