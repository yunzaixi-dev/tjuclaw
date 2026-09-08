// Keep path handling testable without requiring a native runner.
export function prependToolPath(sourceEnv, bin, platform = process.platform) {
  const env = { ...sourceEnv };
  const pathKeys = platform === 'win32'
    ? Object.keys(env).filter(key => key.toUpperCase() === 'PATH').sort()
    : ['PATH'];
  const inheritedPath = env[pathKeys[0]];
  for (const key of pathKeys) delete env[key];
  env.PATH = [bin, inheritedPath].filter(Boolean).join(platform === 'win32' ? ';' : ':');
  return env;
}
