import { URL } from 'node:url';

const ALLOWED_GITLAB_HOSTS = new Set(['gitlab.tju.edu.cn']);
const ALLOWED_GITHUB_HOSTS = new Set(['api.github.com']);
const VALID_SHA_REGEX = /^[0-9a-f]{40}$/;
const VALID_WORKFLOW_NAMES = new Set(['CI', 'Windows Installer']);

export const STATUS_CONTEXT_CI = 'github-actions/ci';
export const STATUS_CONTEXT_WINDOWS = 'github-actions/windows';

export const WORKFLOW_CONTEXT_MAP = {
  'CI': STATUS_CONTEXT_CI,
  'Windows Installer': STATUS_CONTEXT_WINDOWS,
};

/**
 * Maps GitHub check / workflow_run status & conclusion to GitLab commit status state.
 *
 * GitHub run states:
 * status: 'queued' | 'in_progress' | 'completed' | ...
 * conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped' | null
 *
 * GitLab status states:
 * 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped'
 */
export function mapGitHubToGitLabStatus(status, conclusion) {
  if (status === 'queued') {
    return 'pending';
  }
  if (status === 'in_progress') {
    return 'running';
  }
  if (status === 'completed') {
    switch (conclusion) {
      case 'success':
        return 'success';
      case 'failure':
      case 'timed_out':
      case 'action_required':
        return 'failed';
      case 'cancelled':
        return 'canceled';
      case 'skipped':
      case 'neutral':
        return 'skipped';
      default:
        return 'failed';
    }
  }
  return 'pending';
}

/**
 * Validates a 40-character hexadecimal SHA.
 */
export function validateSha(sha) {
  if (typeof sha !== 'string' || !VALID_SHA_REGEX.test(sha)) {
    throw new Error('Invalid SHA: must be a 40-character hexadecimal string');
  }
  return sha;
}

/**
 * Validates and normalizes the GitLab URL.
 */
export function validateGitLabUrl(rawUrl) {
  const parsed = new URL(rawUrl || 'https://gitlab.tju.edu.cn');
  if (parsed.protocol !== 'https:') {
    throw new Error(`GitLab URL protocol must be https: got ${parsed.protocol}`);
  }
  if (!ALLOWED_GITLAB_HOSTS.has(parsed.host)) {
    throw new Error(`GitLab host ${parsed.host} is not allowed; must be one of: ${[...ALLOWED_GITLAB_HOSTS].join(', ')}`);
  }
  return parsed.origin;
}

/**
 * Validates and normalizes GitHub API base URL.
 */
export function validateGitHubApiUrl(rawUrl) {
  const parsed = new URL(rawUrl || 'https://api.github.com');
  if (parsed.protocol !== 'https:') {
    throw new Error(`GitHub API protocol must be https: got ${parsed.protocol}`);
  }
  if (!ALLOWED_GITHUB_HOSTS.has(parsed.host)) {
    throw new Error(`GitHub API host ${parsed.host} is not allowed`);
  }
  return parsed.origin;
}

/**
 * Resolves status context from workflow name.
 */
export function resolveStatusContext(workflowName) {
  const context = WORKFLOW_CONTEXT_MAP[workflowName];
  if (!context) {
    throw new Error(`Unsupported workflow name: "${workflowName}". Expected one of: ${[...VALID_WORKFLOW_NAMES].join(', ')}`);
  }
  return context;
}

/**
 * Checks whether a GitHub run is superseded by another run for the same workflow and SHA.
 * @param {Array} runs - list of runs matching workflow and SHA
 * @param {number} currentRunId - current run ID
 * @returns {boolean} - true if superseded by a newer run
 */
export function isRunSuperseded(runs, currentRunId) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return false;
  }
  return runs.some(run => Number.isSafeInteger(run.id) && run.id > currentRunId);
}

/**
 * Sanitizes errors so that secrets / upstream responses / tokens are never leaked in error messages.
 */
export function sanitizeErrorMessage(err, secretsToRedact = []) {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of secretsToRedact) {
    if (secret && typeof secret === 'string' && secret.length > 3) {
      msg = msg.replaceAll(secret, '[REDACTED]');
    }
  }
  // Strip any Bearer or token-like patterns just in case
  msg = msg.replace(/(?:glpat-|ghp_|github_pat_|bearer\s+)[A-Za-z0-9_.-]+/gi, '[REDACTED]');
  return msg;
}

/**
 * Fetch with timeout (default 20 seconds).
 */
export async function timedFetch(url, options = {}, timeoutMs = 20000) {
  return fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Main execution handler.
 */
export async function syncGitLabStatus(env = process.env) {
  const gitlabToken = env.GITLAB_STATUS_TOKEN;
  if (!gitlabToken) {
    throw new Error('GITLAB_STATUS_TOKEN is required when reporting is enabled');
  }

  const gitlabUrl = validateGitLabUrl(env.GITLAB_URL);
  const gitlabProjectId = env.GITLAB_PROJECT_ID || '145';
  if (gitlabProjectId !== '145') {
    throw new Error(`Invalid GITLAB_PROJECT_ID: ${gitlabProjectId}`);
  }

  const githubToken = env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN environment variable is required');
  }

  const githubRepository = env.GITHUB_REPOSITORY;
  if (githubRepository !== 'yunzaixi-dev/tjuclaw') {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${githubRepository}`);
  }

  const targetRunIdStr = env.TARGET_RUN_ID;
  if (!targetRunIdStr || !/^\d+$/.test(targetRunIdStr)) {
    throw new Error(`Invalid or missing TARGET_RUN_ID: ${targetRunIdStr}`);
  }
  const targetRunId = Number(targetRunIdStr);

  const githubApiOrigin = validateGitHubApiUrl(env.GITHUB_API_URL);

  const secretsToRedact = [gitlabToken, githubToken];

  try {
    // 1. Fetch current run details directly from GitHub API to avoid outdated or tampered payload
    const runUrl = `${githubApiOrigin}/repos/${githubRepository}/actions/runs/${targetRunId}`;
    const runRes = await timedFetch(runUrl, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${githubToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!runRes.ok) {
      throw new Error(`Failed to fetch GitHub run details (HTTP ${runRes.status})`);
    }

    const run = await runRes.json();

    // Verify run repository and workflow identity
    if (run.repository?.full_name !== githubRepository || run.head_repository?.full_name !== githubRepository) {
      throw new Error(`Run repository mismatch: expected ${githubRepository}, got ${run.repository?.full_name}`);
    }

    const workflowName = run.name;
    const statusContext = resolveStatusContext(workflowName);

    // Verify event and branch
    if (run.event !== 'push') {
      console.log(`Skipping status sync: run event is "${run.event}", only "push" is supported.`);
      return { skipped: true, reason: 'UNSUPPORTED_EVENT' };
    }
    if (run.head_branch !== 'release') {
      console.log(`Skipping status sync: head_branch is "${run.head_branch}", only "release" is supported.`);
      return { skipped: true, reason: 'UNSUPPORTED_BRANCH' };
    }

    const headSha = validateSha(run.head_sha);
    const targetUrl = run.html_url;
    if (!targetUrl || typeof targetUrl !== 'string') {
      throw new Error('Missing or invalid run html_url from GitHub');
    }

    if (targetUrl !== `https://github.com/${githubRepository}/actions/runs/${targetRunId}`) {
      throw new Error('Unexpected run target URL');
    }

    // 2. Query other runs for this workflow and SHA to avoid overwriting a newer run
    const runsForCommitUrl = `${githubApiOrigin}/repos/${githubRepository}/actions/workflows/${run.workflow_id}/runs?head_sha=${headSha}&event=push&branch=release&per_page=10`;
    const listRes = await timedFetch(runsForCommitUrl, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${githubToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!listRes.ok) {
      throw new Error(`Failed to verify latest GitHub run (HTTP ${listRes.status})`);
    }
    {
      const listData = await listRes.json();
      if (isRunSuperseded(listData.workflow_runs, targetRunId)) {
        console.log(`Skipping status sync: run ${targetRunId} is superseded by a newer run for SHA ${headSha}.`);
        return { skipped: true, reason: 'SUPERSEDED' };
      }
    }

    // 3. Verify exact commit exists in GitLab upstream project
    const gitlabCommitUrl = `${gitlabUrl}/api/v4/projects/${gitlabProjectId}/repository/commits/${headSha}`;
    const commitRes = await timedFetch(gitlabCommitUrl, {
      headers: {
        'PRIVATE-TOKEN': gitlabToken,
      },
    });

    if (commitRes.status === 404) {
      throw new Error(`Commit ${headSha} not found in GitLab project ${gitlabProjectId}`);
    }
    if (!commitRes.ok) {
      throw new Error(`GitLab commit check failed (HTTP ${commitRes.status})`);
    }

    const commitData = await commitRes.json();
    if (commitData.id !== headSha) {
      throw new Error(`GitLab commit ID mismatch: expected ${headSha}, got ${commitData.id}`);
    }

    // 4. Map status and post status to GitLab
    const gitlabState = mapGitHubToGitLabStatus(run.status, run.conclusion);
    const description = `GitHub Actions [${workflowName}]: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ''}`;

    const postStatusUrl = `${gitlabUrl}/api/v4/projects/${gitlabProjectId}/statuses/${headSha}`;
    const postRes = await timedFetch(postStatusUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PRIVATE-TOKEN': gitlabToken,
      },
      body: JSON.stringify({
        state: gitlabState,
        ref: 'release',
        name: statusContext,
        context: statusContext,
        target_url: targetUrl,
        description: description.slice(0, 255),
      }),
    });

    if (!postRes.ok) {
      throw new Error(`Failed to post status to GitLab (HTTP ${postRes.status})`);
    }

    console.log(`Successfully posted status "${gitlabState}" for commit ${headSha} (${statusContext})`);
    return {
      success: true,
      sha: headSha,
      context: statusContext,
      state: gitlabState,
    };
  } catch (err) {
    const sanitized = sanitizeErrorMessage(err, secretsToRedact);
    console.error(`GitLab status sync failed: ${sanitized}`);
    throw new Error(sanitized);
  }
}

// Self-execute if run as CLI script
if (process.argv[1] && process.argv[1].endsWith('gitlab-status.mjs')) {
  syncGitLabStatus().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
