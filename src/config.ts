/**
 * Configuration from the environment.
 *
 * Auth and endpoint come entirely from the MCP host as environment variables (the `--env`
 * flags of `claude mcp add`, or the `env` block of an MCP client config). No files are read.
 *
 * Least-privilege by design: the READ token is required (the server refuses to start
 * without it); the WRITE token is optional. When the WRITE token is absent, mutating
 * operations are not registered at all and the dispatcher refuses them, so the server is
 * physically incapable of changing anything on the panel.
 *
 * Remnawave >= 3.0 supports scoped API tokens (Settings -> API tokens). Mint one token with
 * read-only scopes and a second with the write scopes you actually need.
 */

export type ToolProfile = "minimal" | "core" | "full";

export interface Config {
  baseUrl: string;
  readToken: string;
  writeToken: string | null;
  canWrite: boolean;
  profile: ToolProfile;
  /** Controllers whose operations get individual typed tools (empty = none). */
  controllers: string[] | null;
  /** Body/param schemas larger than this are collapsed in tools/list (full one via describe). */
  maxSchemaBytes: number;
  /** Minimum gap between two mutating calls — the panel pushes config to every node on write. */
  writeMinIntervalMs: number;
  maxRetries: number;
  timeoutMs: number;
  /** When false, destructive (bulk/delete-all/restart-all) operations need `confirm: true`. */
  skipConfirm: boolean;
}

/** Controllers exposed as typed tools under the (opt-in) `core` profile. */
export const CORE_CONTROLLERS = [
  "users",
  "users-bulk-actions",
  "nodes",
  "hosts",
  "hosts-bulk-actions",
  "config-profiles",
  "internal-squads",
  "system",
];

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function boolEnv(env: NodeJS.ProcessEnv, key: string, fallback = false): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrlRaw = env.REMNAWAVE_BASE_URL?.trim();
  if (!baseUrlRaw) {
    throw new Error(
      "REMNAWAVE_BASE_URL is required, e.g. https://panel.example.com (no trailing /api)."
    );
  }
  let baseUrl: string;
  try {
    baseUrl = new URL(baseUrlRaw).origin + new URL(baseUrlRaw).pathname.replace(/\/+$/, "");
  } catch {
    throw new Error(`REMNAWAVE_BASE_URL is not a valid URL: ${baseUrlRaw}`);
  }
  baseUrl = baseUrl.replace(/\/api$/, "");

  // REMNAWAVE_API_TOKEN is accepted as an alias so the panel's own .env variable name works.
  const readToken =
    env.REMNAWAVE_API_TOKEN_READ?.trim() || env.REMNAWAVE_API_TOKEN?.trim() || "";
  if (!readToken) {
    throw new Error(
      "REMNAWAVE_API_TOKEN_READ is required. Create an API token in the panel " +
        "(Settings -> API tokens) and grant it read scopes."
    );
  }
  const writeToken = env.REMNAWAVE_API_TOKEN_WRITE?.trim() || null;

  const profileRaw = (env.REMNAWAVE_TOOL_PROFILE?.trim().toLowerCase() ?? "minimal") as ToolProfile;
  if (!["minimal", "core", "full"].includes(profileRaw)) {
    throw new Error(
      `REMNAWAVE_TOOL_PROFILE must be one of minimal|core|full (got '${profileRaw}').`
    );
  }

  const controllersRaw = env.REMNAWAVE_CONTROLLERS?.trim();
  let controllers: string[] | null;
  if (controllersRaw) {
    controllers = controllersRaw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  } else if (profileRaw === "minimal") {
    controllers = [];
  } else if (profileRaw === "core") {
    controllers = [...CORE_CONTROLLERS];
  } else {
    controllers = null; // full: every controller
  }

  return {
    baseUrl,
    readToken,
    writeToken,
    canWrite: writeToken !== null,
    profile: profileRaw,
    controllers,
    maxSchemaBytes: intEnv(env, "REMNAWAVE_MAX_SCHEMA_BYTES", 2000),
    writeMinIntervalMs: intEnv(env, "REMNAWAVE_WRITE_MIN_INTERVAL_MS", 1500),
    maxRetries: intEnv(env, "REMNAWAVE_MAX_RETRIES", 3),
    timeoutMs: intEnv(env, "REMNAWAVE_TIMEOUT_MS", 30000),
    skipConfirm: boolEnv(env, "REMNAWAVE_SKIP_CONFIRM"),
  };
}
