/**
 * tool-stats — prints the size of the advertised tool list for each profile.
 *
 * This is the number that justifies the tiered design: `tools/list` is sent to the model on
 * every single request, so its serialized size is a permanent context tax. Run it after
 * changing schemas, notes or the core controller list.
 *
 *   npx tsx scripts/tool-stats.ts
 */
import { buildServer } from "../src/index.js";

const ENV_BASE = {
  REMNAWAVE_BASE_URL: "https://panel.example.com",
  REMNAWAVE_API_TOKEN_READ: "dummy-read",
  REMNAWAVE_API_TOKEN_WRITE: "dummy-write",
};

const profiles = ["minimal", "core", "full"] as const;

console.log("profile   tools   tools/list bytes   ~tokens");
for (const profile of profiles) {
  const { tools } = buildServer({
    ...ENV_BASE,
    REMNAWAVE_TOOL_PROFILE: profile,
  } as NodeJS.ProcessEnv);
  const bytes = JSON.stringify(tools).length;
  console.log(
    `${profile.padEnd(9)} ${String(tools.length).padStart(5)}   ${String(bytes).padStart(16)}   ` +
      `~${Math.round(bytes / 4)}`
  );
}

// Read-only variants (no write token) for comparison.
console.log("\nread-only (no write token):");
for (const profile of profiles) {
  const { tools } = buildServer({
    REMNAWAVE_BASE_URL: ENV_BASE.REMNAWAVE_BASE_URL,
    REMNAWAVE_API_TOKEN_READ: ENV_BASE.REMNAWAVE_API_TOKEN_READ,
    REMNAWAVE_TOOL_PROFILE: profile,
  } as NodeJS.ProcessEnv);
  const bytes = JSON.stringify(tools).length;
  console.log(
    `${profile.padEnd(9)} ${String(tools.length).padStart(5)}   ${String(bytes).padStart(16)}   ` +
      `~${Math.round(bytes / 4)}`
  );
}
