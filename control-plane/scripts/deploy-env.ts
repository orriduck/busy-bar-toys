/** Keep the main native-build target guard, isolate only the legacy child. */
export function legacyDeployEnv(env: Record<string, string | undefined>) {
  const isolated = { ...env };
  delete isolated.WRANGLER_CI_OVERRIDE_NAME;
  delete isolated.WRANGLER_CI_MATCH_TAG;
  return isolated;
}
