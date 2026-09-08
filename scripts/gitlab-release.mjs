import { URL, fileURLToPath } from 'node:url';
import { open, readFile, stat, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

export const ALLOWED_GITLAB_HOSTS = new Set(['gitlab.tju.edu.cn']);
export const ALLOWED_PROJECT_ID = '145';
export const PACKAGE_NAME = 'tjuclaw-client';
export const MAX_FILE_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const VALID_SHA_REGEX = /^[0-9a-f]{40}$/;
export const VALID_SHA256_REGEX = /^[0-9a-f]{64}$/;
export const VALID_TAG_REGEX = /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
export const VALID_FILENAME_REGEX = /^[a-zA-Z0-9._-]+$/;

/**
 * Validates 40-hex SHA string.
 */
export function validateSha(sha, fieldName = 'commit ref') {
  if (typeof sha !== 'string' || !VALID_SHA_REGEX.test(sha)) {
    throw new Error(`Invalid ${fieldName}: must be a 40-character hexadecimal string`);
  }
  return sha;
}

/**
 * Validates 64-hex SHA256 string.
 */
export function validateSha256(hash, fieldName = 'sha256') {
  if (typeof hash !== 'string' || !VALID_SHA256_REGEX.test(hash)) {
    throw new Error(`Invalid ${fieldName}: must be a 64-character hexadecimal string`);
  }
  return hash;
}

/**
 * Validates and normalizes GitLab URL. Strictly https://gitlab.tju.edu.cn.
 */
export function validateGitLabUrl(rawUrl) {
  const parsed = new URL(rawUrl || 'https://gitlab.tju.edu.cn');
  if (parsed.protocol !== 'https:') {
    throw new Error(`GitLab URL protocol must be https: got ${parsed.protocol}`);
  }
  if (!ALLOWED_GITLAB_HOSTS.has(parsed.host)) {
    throw new Error(`GitLab host ${parsed.host} is not allowed; must be one of: ${[...ALLOWED_GITLAB_HOSTS].join(', ')}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('GitLab URL must not contain user credentials');
  }
  if (parsed.search) {
    throw new Error('GitLab URL must not contain query parameters');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(`GitLab URL must not contain a path: got ${parsed.pathname}`);
  }
  if (parsed.hash) {
    throw new Error('GitLab URL must not contain a hash fragment');
  }
  return parsed.origin;
}

/**
 * Validates GitLab project ID. Strictly '145'.
 */
export function validateProjectId(id) {
  const normalized = String(id ?? ALLOWED_PROJECT_ID);
  if (normalized !== ALLOWED_PROJECT_ID) {
    throw new Error(`Invalid GITLAB_PROJECT_ID: ${normalized}; expected ${ALLOWED_PROJECT_ID}`);
  }
  return normalized;
}

/**
 * Redacts secrets from error strings.
 */
export function sanitizeErrorMessage(err, secretsToRedact = []) {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of secretsToRedact) {
    if (secret && typeof secret === 'string' && secret.length > 3) {
      msg = msg.replaceAll(secret, '[REDACTED]');
    }
  }
  msg = msg.replace(/(?:glpat-|ghp_|github_pat_|bearer\s+)[A-Za-z0-9_.-]+/gi, '[REDACTED]');
  return msg;
}

/**
 * Fetch with timeout and strict redirect: 'error'.
 */
export async function timedFetch(url, options = {}, timeoutMs = 30000) {
  return fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Verifies local file: must exist, be regular file, not a symlink, size <= 1 GiB.
 * Computes sha256 checksum and compares against expectedSha256.
 */
export async function verifyLocalFile(filePath, expectedSha256) {
  const resolvedPath = resolve(filePath);
  const lst = await lstat(resolvedPath);
  if (lst.isSymbolicLink()) {
    throw new Error(`File is a symbolic link, which is rejected: ${resolvedPath}`);
  }

  const st = await stat(resolvedPath);
  if (!st.isFile()) {
    throw new Error(`Path is not a regular file: ${resolvedPath}`);
  }
  if (st.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File size ${st.size} exceeds maximum allowed size of 1 GiB: ${resolvedPath}`);
  }

  const fileHandle = await open(resolvedPath, 'r');
  const hasher = createHash('sha256');
  try {
    const stream = fileHandle.createReadStream();
    for await (const chunk of stream) {
      hasher.update(chunk);
    }
  } finally {
    await fileHandle.close();
  }

  const computedSha256 = hasher.digest('hex');
  if (computedSha256 !== expectedSha256) {
    throw new Error(`Checksum mismatch for ${resolvedPath}: expected ${expectedSha256}, got ${computedSha256}`);
  }

  return {
    path: resolvedPath,
    size: st.size,
    sha256: computedSha256,
  };
}

/**
 * Validates the complete release manifest structure.
 */
export async function validateReleaseManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Manifest must be a valid JSON object');
  }

  const { version, tag, ref, client_sha, files, description } = manifest;

  if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid version in manifest: "${version}"`);
  }

  if (typeof tag !== 'string' || !VALID_TAG_REGEX.test(tag)) {
    throw new Error(`Invalid tag in manifest: "${tag}"`);
  }
  if (tag !== `v${version}`) {
    throw new Error(`Tag "${tag}" does not match version "v${version}"`);
  }

  validateSha(ref, 'ref');
  validateSha(client_sha, 'client_sha');

  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Manifest files must be a non-empty array');
  }

  const seenNames = new Set();
  const validatedFiles = [];

  for (const item of files) {
    if (!item || typeof item !== 'object') {
      throw new Error('Invalid file item in manifest');
    }
    const { path: filePath, name, sha256 } = item;

    if (typeof name !== 'string' || !VALID_FILENAME_REGEX.test(name) || name !== basename(name) || name === '.' || name === '..') {
      throw new Error(`Invalid or path-traversal filename: "${name}"`);
    }

    if (seenNames.has(name)) {
      throw new Error(`Duplicate filename in manifest: "${name}"`);
    }
    seenNames.add(name);

    validateSha256(sha256, `file ${name} sha256`);

    if (typeof filePath !== 'string' || !filePath) {
      throw new Error(`Missing local path for file ${name}`);
    }

    const verified = await verifyLocalFile(filePath, sha256);
    validatedFiles.push({
      ...verified,
      name,
    });
  }

  return {
    version,
    tag,
    ref,
    client_sha,
    description: typeof description === 'string' ? description : '',
    files: validatedFiles,
  };
}

/**
 * Computes sha256 from a readable stream up to maxBytes.
 */
export async function streamSha256(stream, maxBytes = MAX_FILE_SIZE_BYTES) {
  const hasher = createHash('sha256');
  let bytesRead = 0;
  for await (const chunk of stream) {
    bytesRead += chunk.length;
    if (bytesRead > maxBytes) {
      throw new Error(`Stream size exceeded ${maxBytes} bytes`);
    }
    hasher.update(chunk);
  }
  return hasher.digest('hex');
}

/**
 * Checks existing package file in Generic Package Registry.
 * Returns:
 *   { exists: false }
 *   { exists: true, sha256: string, match: boolean }
 */
export async function checkExistingPackageFile(packageFileUrl, token, expectedSha256, fetchFn = timedFetch) {
  const headRes = await fetchFn(packageFileUrl, {
    method: 'HEAD',
    headers: { 'PRIVATE-TOKEN': token },
  });

  if (headRes.status === 404) {
    return { exists: false };
  }

  if (headRes.status === 200) {
    const headerSha = headRes.headers?.get?.('x-checksum-sha256');
    if (headerSha && headerSha === expectedSha256) {
      return { exists: true, sha256: headerSha, match: true };
    }

    const getRes = await fetchFn(packageFileUrl, {
      method: 'GET',
      headers: { 'PRIVATE-TOKEN': token },
    });
    if (!getRes.ok) {
      throw new Error(`Failed to retrieve existing package file for checksum check (HTTP ${getRes.status})`);
    }
    const remoteHash = await streamSha256(getRes.body);
    const match = remoteHash === expectedSha256;
    return { exists: true, sha256: remoteHash, match };
  }

  if (headRes.status === 403 || headRes.status === 401) {
    throw new Error(`GitLab authentication failed for package check (HTTP ${headRes.status})`);
  }

  throw new Error(`Unexpected HTTP status checking package file: ${headRes.status}`);
}

/**
 * Verifies integration commit and release tag existence & matching.
 */
export async function verifyCommitAndTag(gitlabUrl, projectId, ref, tag, token, fetchFn = timedFetch) {
  // 1. Verify exact integration commit exists
  const commitUrl = `${gitlabUrl}/api/v4/projects/${projectId}/repository/commits/${ref}`;
  const commitRes = await fetchFn(commitUrl, {
    headers: { 'PRIVATE-TOKEN': token },
  });
  if (commitRes.status === 404) {
    throw new Error(`Integration commit ref ${ref} not found in GitLab project ${projectId}`);
  }
  if (!commitRes.ok) {
    throw new Error(`GitLab commit verification failed (HTTP ${commitRes.status})`);
  }
  const commitData = await commitRes.json();
  if (commitData.id !== ref) {
    throw new Error(`GitLab commit id mismatch: expected ${ref}, got ${commitData.id}`);
  }

  // 2. Check if release tag already exists
  const tagUrl = `${gitlabUrl}/api/v4/projects/${projectId}/repository/tags/${encodeURIComponent(tag)}`;
  const tagRes = await fetchFn(tagUrl, {
    headers: { 'PRIVATE-TOKEN': token },
  });

  if (tagRes.status === 200) {
    const tagData = await tagRes.json();
    const tagTargetSha = tagData.commit?.id || tagData.target;
    if (tagTargetSha !== ref) {
      throw new Error(`Existing release tag "${tag}" points to ${tagTargetSha}, not integration ref ${ref}`);
    }
    return { tagExists: true, refMatches: true };
  } else if (tagRes.status === 404) {
    return { tagExists: false, refMatches: true };
  } else {
    throw new Error(`Failed to check existing tag "${tag}" (HTTP ${tagRes.status})`);
  }
}

/**
 * Uploads a file to GitLab Generic Package Registry.
 */
export async function uploadPackageFile(gitlabUrl, projectId, version, fileItem, token, fetchFn = timedFetch) {
  const packageFileUrl = `${gitlabUrl}/api/v4/projects/${projectId}/packages/generic/${PACKAGE_NAME}/${version}/${encodeURIComponent(fileItem.name)}`;

  const existing = await checkExistingPackageFile(packageFileUrl, token, fileItem.sha256, fetchFn);
  if (existing.exists) {
    if (existing.match) {
      return { skipped: true, name: fileItem.name, packageFileUrl, sha256: fileItem.sha256 };
    }
    throw new Error(`File "${fileItem.name}" already exists in package version ${version} with different checksum (${existing.sha256} vs ${fileItem.sha256}). Refusing to overwrite.`);
  }

  const handle = await open(fileItem.path, 'r');
  try {
    const bodyStream = handle.createReadStream();
    const putRes = await fetchFn(packageFileUrl, {
      method: 'PUT',
      headers: {
        'PRIVATE-TOKEN': token,
        'Content-Type': 'application/octet-stream',
      },
      body: bodyStream,
      duplex: 'half',
    });

    if (putRes.status === 201 || putRes.status === 200) {
      return { uploaded: true, name: fileItem.name, packageFileUrl, sha256: fileItem.sha256 };
    }

    if (putRes.status === 409) {
      const recheck = await checkExistingPackageFile(packageFileUrl, token, fileItem.sha256, fetchFn);
      if (recheck.exists && recheck.match) {
        return { skipped: true, name: fileItem.name, packageFileUrl, sha256: fileItem.sha256 };
      }
      throw new Error(`Upload conflict (HTTP 409) for "${fileItem.name}" and remote checksum does not match`);
    }

    throw new Error(`Failed to upload "${fileItem.name}" to generic package registry (HTTP ${putRes.status})`);
  } finally {
    await handle.close();
  }
}

/**
 * Creates or updates GitLab Release with asset links.
 */
export async function publishGitLabRelease(gitlabUrl, projectId, manifest, uploadedAssets, token, fetchFn = timedFetch) {
  const releaseUrl = `${gitlabUrl}/api/v4/projects/${projectId}/releases/${encodeURIComponent(manifest.tag)}`;
  const checkRes = await fetchFn(releaseUrl, {
    headers: { 'PRIVATE-TOKEN': token },
  });

  const assetsLinks = uploadedAssets.map((asset) => ({
    name: asset.name,
    url: asset.packageFileUrl,
    direct_asset_path: `/${asset.name}`,
    link_type: 'package',
  }));

  const releasePayload = {
    name: `Release ${manifest.tag}`,
    tag_name: manifest.tag,
    ref: manifest.ref,
    description: manifest.description || `Automated release ${manifest.tag} for integration ref ${manifest.ref}\nClient SHA: ${manifest.client_sha}`,
    assets: {
      links: assetsLinks,
    },
  };

  if (checkRes.status === 404) {
    const createUrl = `${gitlabUrl}/api/v4/projects/${projectId}/releases`;
    const createRes = await fetchFn(createUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PRIVATE-TOKEN': token,
      },
      body: JSON.stringify(releasePayload),
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create GitLab release ${manifest.tag} (HTTP ${createRes.status})`);
    }
    const data = await createRes.json();
    return { action: 'created', data };
  } else if (checkRes.status === 200) {
    const existingLinksRes = await fetchFn(`${releaseUrl}/assets/links`, {
      headers: { 'PRIVATE-TOKEN': token },
    });
    if (!existingLinksRes.ok) {
      throw new Error(`Failed to retrieve existing asset links for release ${manifest.tag} (HTTP ${existingLinksRes.status})`);
    }
    const existingLinks = await existingLinksRes.json();
    if (!Array.isArray(existingLinks)) {
      throw new Error(`Invalid response for release asset links of ${manifest.tag}: expected array`);
    }

    for (const link of assetsLinks) {
      const sameNameLink = existingLinks.find((l) => l.name === link.name);
      if (sameNameLink && sameNameLink.url !== link.url) {
        throw new Error(
          `Asset link conflict for "${link.name}": existing URL "${sameNameLink.url}" does not match target URL "${link.url}"`
        );
      }
    }

    const updateRes = await fetchFn(releaseUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'PRIVATE-TOKEN': token,
      },
      body: JSON.stringify({
        description: releasePayload.description,
      }),
    });
    if (!updateRes.ok) {
      throw new Error(`Failed to update existing GitLab release ${manifest.tag} (HTTP ${updateRes.status})`);
    }

    for (const link of assetsLinks) {
      const match = existingLinks.find((l) => l.name === link.name);
      if (!match) {
        const addRes = await fetchFn(`${releaseUrl}/assets/links`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'PRIVATE-TOKEN': token,
          },
          body: JSON.stringify(link),
        });
        if (!addRes.ok) {
          throw new Error(`Failed to add asset link ${link.name} (HTTP ${addRes.status})`);
        }
      } else if (match.direct_asset_path !== link.direct_asset_path) {
        if (!match.id) {
          throw new Error(`Cannot update direct asset path for link "${link.name}": link id missing`);
        }
        const putLinkRes = await fetchFn(`${releaseUrl}/assets/links/${match.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'PRIVATE-TOKEN': token,
          },
          body: JSON.stringify({
            direct_asset_path: link.direct_asset_path,
          }),
        });
        if (!putLinkRes.ok) {
          throw new Error(`Failed to update direct asset path for link "${link.name}" (HTTP ${putLinkRes.status})`);
        }
      }
    }
    return { action: 'updated', tag: manifest.tag };
  } else {
    throw new Error(`Failed to query release status for ${manifest.tag} (HTTP ${checkRes.status})`);
  }
}

/**
 * Main release transport orchestrator.
 */
export async function executeGitLabRelease(rawManifest, options = {}) {
  const env = options.env || process.env;
  const fetchFn = options.fetchFn || timedFetch;
  const isDryRun = options.dryRun || env.DRY_RUN === 'true' || process.argv.includes('--dry-run');

  const gitlabUrl = validateGitLabUrl(env.GITLAB_URL);
  const projectId = validateProjectId(env.GITLAB_PROJECT_ID);

  const token = env.GITLAB_RELEASE_TOKEN;
  if (!token && !isDryRun) {
    throw new Error('GITLAB_RELEASE_TOKEN environment variable is required');
  }

  const secretsToRedact = [token].filter(Boolean);

  try {
    const validatedManifest = await validateReleaseManifest(rawManifest);

    if (isDryRun) {
      const plannedUploads = validatedManifest.files.map((f) => ({
        name: f.name,
        size: f.size,
        sha256: f.sha256,
        targetEndpoint: `${gitlabUrl}/api/v4/projects/${projectId}/packages/generic/${PACKAGE_NAME}/${validatedManifest.version}/${f.name}`,
        directAssetPath: `/${f.name}`,
      }));

      return {
        dryRun: true,
        version: validatedManifest.version,
        tag: validatedManifest.tag,
        ref: validatedManifest.ref,
        clientSha: validatedManifest.client_sha,
        plannedUploads,
        releaseEndpoint: `${gitlabUrl}/api/v4/projects/${projectId}/releases/${validatedManifest.tag}`,
      };
    }

    await verifyCommitAndTag(gitlabUrl, projectId, validatedManifest.ref, validatedManifest.tag, token, fetchFn);

    const uploadedAssets = [];
    for (const file of validatedManifest.files) {
      const result = await uploadPackageFile(gitlabUrl, projectId, validatedManifest.version, file, token, fetchFn);
      uploadedAssets.push(result);
    }

    const releaseResult = await publishGitLabRelease(gitlabUrl, projectId, validatedManifest, uploadedAssets, token, fetchFn);

    return {
      success: true,
      tag: validatedManifest.tag,
      version: validatedManifest.version,
      ref: validatedManifest.ref,
      release: releaseResult,
      assets: uploadedAssets,
    };
  } catch (err) {
    const sanitized = sanitizeErrorMessage(err, secretsToRedact);
    throw new Error(sanitized);
  }
}

/**
 * CLI runner.
 */
export async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
  const manifestArg = args.find((a) => !a.startsWith('--')) || process.env.RELEASE_MANIFEST_PATH;

  if (!manifestArg) {
    console.error('Usage: node scripts/gitlab-release.mjs [--dry-run] <path-to-manifest.json>');
    process.exit(1);
  }

  let manifestContent;
  try {
    manifestContent = await readFile(resolve(manifestArg), 'utf8');
  } catch (err) {
    throw new Error(`Failed to read manifest file at "${manifestArg}": ${err?.code || 'IO error'}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch {
    throw new Error('Failed to parse release manifest: Invalid JSON syntax');
  }

  const result = await executeGitLabRelease(manifest, { dryRun: isDryRun });
  if (result.dryRun) {
    console.log('[DRY-RUN] Release transport planned successfully:');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[SUCCESS] Released tag ${result.tag} to GitLab project ${ALLOWED_PROJECT_ID}`);
    console.log(JSON.stringify(result, null, 2));
  }
}

const isEntrypoint = Boolean(process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]));
if (isEntrypoint) {
  main().catch((err) => {
    const token = process.env.GITLAB_RELEASE_TOKEN;
    const sanitized = sanitizeErrorMessage(err?.message || 'Unknown release error', [token].filter(Boolean));
    console.error(`Fatal: ${sanitized}`);
    process.exit(1);
  });
}
