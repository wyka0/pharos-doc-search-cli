/**
 * Session cache for the Pharos Agent Center bearer token.
 *
 * The cached file lives under `.local/` (git-ignored) and is written with restrictive
 * permissions where the platform supports it. The token is never logged: only its
 * token type, expiry and a redacted identity are ever surfaced.
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const DEFAULT_STATE_FILE = ".local/session.json";

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveStateFile(env = process.env) {
  return env.PHAROS_STATE_FILE && env.PHAROS_STATE_FILE.trim() ? env.PHAROS_STATE_FILE.trim() : DEFAULT_STATE_FILE;
}

/**
 * @typedef {{
 *   accessToken: string,
 *   tokenType?: string,
 *   expiresAt?: string,
 *   sessionId?: string,
 *   address?: string,
 *   chainId?: number,
 *   updatedAt?: string,
 * }} SessionState
 */

/**
 * Read a cached session. Returns `null` when absent or unparsable — never throws for a
 * missing file, because "not logged in" is a normal state that the CLI reports actionably.
 * @param {string} file
 * @returns {Promise<SessionState | null>}
 */
export async function loadSession(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed.accessToken === "string" && parsed.accessToken) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @param {SessionState} state
 */
export async function saveSession(file, state) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  try {
    await chmod(file, 0o600);
  } catch {
    /* best effort — Windows ACLs are not POSIX modes */
  }
  return file;
}

/**
 * Resolve the bearer token from (in order): an explicit env var, the cached session file.
 * @param {{ env?: NodeJS.ProcessEnv, stateFile?: string }} [options]
 * @returns {Promise<{ token: string | null, source: "env" | "file" | null, tokenType: string | null, expiresAt: string | null, address: string | null, stateFile: string }>}
 */
export async function resolveAuth(options = {}) {
  const env = options.env ?? process.env;
  const stateFile = options.stateFile ?? resolveStateFile(env);

  const fromEnv = env.PHAROS_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    return { token: fromEnv, source: "env", tokenType: "AUTHENTICATED", expiresAt: null, address: null, stateFile };
  }

  const session = await loadSession(stateFile);
  if (session?.accessToken) {
    return {
      token: session.accessToken,
      source: "file",
      tokenType: session.tokenType ?? "AUTHENTICATED",
      expiresAt: session.expiresAt ?? null,
      address: session.address ?? null,
      stateFile,
    };
  }
  return { token: null, source: null, tokenType: null, expiresAt: null, address: null, stateFile };
}
