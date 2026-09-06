import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [tool, ...args] = process.argv.slice(2);
if (!['tauri', 'cargo', 'rustup'].includes(tool)) throw new Error('Expected tauri, cargo or rustup');
const bin = join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'bin');
const rustup = join(bin, process.platform === 'win32' ? 'rustup.exe' : 'rustup');
const env = { ...process.env };
if (existsSync(rustup)) env.PATH = [bin, env.PATH].filter(Boolean).join(delimiter);
const command = tool === 'tauri' ? process.execPath : tool;
if (tool === 'tauri') {
  args.unshift(fileURLToPath(new URL('../frontend/node_modules/@tauri-apps/cli/tauri.js', import.meta.url)));
}
const result = spawnSync(command, args, { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
