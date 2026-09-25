export const LEGACY_ENV_PREFIX = 'SITEVAULT_';
export const ENV_PREFIX = 'WEBCAPTURE_';

export function applyLegacyEnvironment(env = process.env) {
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY_ENV_PREFIX)) continue;
    const current = `${ENV_PREFIX}${name.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[current] === undefined) env[current] = value;
  }
  return env;
}

applyLegacyEnvironment();
