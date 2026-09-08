import { readFileSync } from 'node:fs';

// Git credential helper, deliberately limited to the competition repository.
if (process.argv[2] === 'get') {
  const fields = Object.fromEntries(readFileSync(0, 'utf8').trim().split('\n').map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (fields.protocol === 'https' && fields.host === 'gitlab.tju.edu.cn'
    && fields.path === '3023244020/agent2026-tjuclaw.git' && process.env.GITLAB_SYNC_TOKEN) {
    process.stdout.write(`username=oauth2\npassword=${process.env.GITLAB_SYNC_TOKEN}\n\n`);
  }
}
