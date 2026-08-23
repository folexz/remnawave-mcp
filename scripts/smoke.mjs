#!/usr/bin/env node
/**
 * smoke.mjs — read-only end-to-end check against a live Remnawave panel.
 *
 * Run it where the token already lives (e.g. on the panel host) so the secret never has to
 * travel:
 *
 *   set -a; . /opt/remnawave/.env; set +a
 *   REMNAWAVE_BASE_URL=https://panel.example.com \
 *   REMNAWAVE_API_TOKEN_READ="$REMNAWAVE_API_TOKEN" \
 *   node scripts/smoke.mjs
 *
 * It only exercises GETs and the local guard rails. It deliberately prints shapes — types,
 * key names, array lengths — and never payload values, so the output is safe to paste into
 * an issue or a chat.
 */
import { buildServer } from "../dist/index.js";

const results = [];

function shape(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `array(${value.length})${value.length && depth < 1 ? ` of ${shape(value[0], depth + 1)}` : ""}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    return `object{${keys.slice(0, 14).join(",")}${keys.length > 14 ? ",…" : ""}}`;
  }
  return typeof value;
}

async function check(name, fn) {
  try {
    const value = await fn();
    results.push({ name, ok: true, detail: value });
    console.log(`  PASS  ${name} — ${value}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}

/** Runs a tool through the same handler map the MCP transport uses. */
function caller(handlers) {
  return async (tool, args) => {
    const handler = handlers.get(tool);
    if (!handler) throw new Error(`tool '${tool}' not registered`);
    return handler(args ?? {});
  };
}

const liveEnv = {
  REMNAWAVE_BASE_URL: process.env.REMNAWAVE_BASE_URL,
  REMNAWAVE_API_TOKEN_READ:
    process.env.REMNAWAVE_API_TOKEN_READ || process.env.REMNAWAVE_API_TOKEN,
};
const hasLive = Boolean(liveEnv.REMNAWAVE_BASE_URL && liveEnv.REMNAWAVE_API_TOKEN_READ);

/**
 * Guard-rail checks run against the discard port, never a real panel: if a gate ever fails
 * open, the request dies locally instead of reaching production.
 */
const SANDBOX_URL = "http://127.0.0.1:9";

const baseEnv = hasLive
  ? liveEnv
  : { REMNAWAVE_BASE_URL: SANDBOX_URL, REMNAWAVE_API_TOKEN_READ: "offline" };

const { handlers, tools, catalogue, config } = buildServer(baseEnv);
const call = caller(handlers);

console.log(
  `remnawave-mcp smoke — ${catalogue.apiTitle}, ` +
    `${catalogue.operationCount} operations, ${tools.length} tools, ` +
    `profile=${config.profile}, write=${config.canWrite}, live=${hasLive}\n`
);

console.log("offline checks (no network):");

await check("catalogue overview lists controllers", async () => {
  const r = await call("remnawave_list_operations", {});
  if (!Array.isArray(r.controllers) || r.controllers.length < 20) throw new Error("too few controllers");
  return `${r.operations} ops in ${r.controllers.length} controllers`;
});

await check("search finds host operations", async () => {
  const r = await call("remnawave_list_operations", { controller: "hosts" });
  return `${r.matched} matched`;
});

await check("describe resolves by name / operationId / route", async () => {
  const a = await call("remnawave_describe_operation", { operation: "remnawave_patch_config_profiles" });
  const b = await call("remnawave_describe_operation", { operation: a.operationId });
  const c = await call("remnawave_describe_operation", { operation: "patch /api/config-profiles" });
  if (a.name !== b.name || b.name !== c.name) throw new Error("resolvers disagree");
  if (!a.notes?.some((n) => n.includes("A061"))) throw new Error("config-profile note missing");
  return `${a.name} (${a.notes.length} notes)`;
});

await check("read-only server hides mutating tools", async () => {
  const mutating = tools.filter((t) => t.annotations?.readOnlyHint === false && t.name !== "remnawave_call");
  if (mutating.length) throw new Error(`exposed: ${mutating.map((t) => t.name).join(",")}`);
  if (handlers.has("remnawave_request_write")) throw new Error("write escape hatch registered");
  return "no write tools registered";
});

await check("dispatcher refuses a write without a write token", async () => {
  try {
    await call("remnawave_call", { operation: "remnawave_delete_users_user_id", params: { userId: "x" } });
  } catch (err) {
    if (/read-only/.test(err.message)) return "refused as expected";
    throw err;
  }
  throw new Error("write was NOT refused");
});

await check("unknown operation suggests alternatives", async () => {
  try {
    await call("remnawave_call", { operation: "users" });
  } catch (err) {
    if (/Unknown operation/.test(err.message)) return "suggestions returned";
    throw err;
  }
  throw new Error("no error raised");
});

console.log("\nwrite-mode guard rails (sandboxed at 127.0.0.1:9 — cannot reach a panel):");

const writeSandbox = buildServer({
  REMNAWAVE_BASE_URL: SANDBOX_URL,
  REMNAWAVE_API_TOKEN_READ: "sandbox-read",
  REMNAWAVE_API_TOKEN_WRITE: "sandbox-write",
  REMNAWAVE_TOOL_PROFILE: "core",
  REMNAWAVE_MAX_RETRIES: "0",
  REMNAWAVE_TIMEOUT_MS: "2000",
});
const sandboxCall = caller(writeSandbox.handlers);

await check("core profile registers typed tools", async () => {
  const typed = writeSandbox.tools.filter((t) => t.name.startsWith("remnawave_") && writeSandbox.generatedCount);
  if (writeSandbox.generatedCount < 40) throw new Error(`only ${writeSandbox.generatedCount} typed tools`);
  return `${writeSandbox.generatedCount} typed tools, ${typed.length} total`;
});

await check("write escape hatch appears only with a write token", async () =>
  writeSandbox.handlers.has("remnawave_request_write")
    ? "registered"
    : (() => {
        throw new Error("missing");
      })()
);

await check("destructive op is refused without confirm=true", async () => {
  try {
    await sandboxCall("remnawave_call", {
      operation: "remnawave_post_users_bulk_delete",
      params: { body: { uuids: [] } },
    });
  } catch (err) {
    if (/confirm=true/.test(err.message)) return "gate held";
    throw err;
  }
  throw new Error("destructive op was NOT gated");
});

await check("destructive typed tool requires confirm in its schema", async () => {
  const tool = writeSandbox.tools.find((t) => t.name === "remnawave_post_users_bulk_delete");
  if (!tool) throw new Error("tool missing from core profile");
  if (!tool.inputSchema.required?.includes("confirm")) throw new Error("confirm not required");
  return "confirm required";
});

await check("oversized host schema is collapsed with a pointer to describe", async () => {
  const tool = writeSandbox.tools.find((t) => t.name === "remnawave_post_hosts");
  const serialized = JSON.stringify(tool.inputSchema);
  const full = JSON.stringify(
    (await sandboxCall("remnawave_describe_operation", { operation: "remnawave_post_hosts" })).inputSchema
  );
  if (serialized.length >= full.length) throw new Error("schema was not collapsed");
  if (!serialized.includes("remnawave_describe_operation")) throw new Error("no pointer to describe");
  return `${serialized.length} B advertised vs ${full.length} B full`;
});

await check("missing required body is caught before any HTTP call", async () => {
  try {
    await sandboxCall("remnawave_call", { operation: "remnawave_post_users", params: {} });
  } catch (err) {
    if (/requires a 'body'/.test(err.message)) return "rejected locally";
    throw err;
  }
  throw new Error("no local validation");
});

if (!hasLive) {
  const failedOffline = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failedOffline.length}/${results.length} checks passed ` +
      `(live checks skipped — set REMNAWAVE_BASE_URL and REMNAWAVE_API_TOKEN_READ)`
  );
  process.exit(failedOffline.length ? 1 : 0);
}

console.log("\nlive read-only checks:");

await check("GET /api/system/health", async () => {
  const r = await call("remnawave_request_read", { path: "/api/system/health" });
  if (r && typeof r === "object" && "response" in r) throw new Error("envelope not unwrapped");
  return shape(r);
});

await check("GET /api/system/stats", async () => shape(await call("remnawave_request_read", { path: "/api/system/stats" })));

await check("GET /api/nodes via dispatcher", async () => {
  const r = await call("remnawave_call", { operation: "remnawave_get_nodes" });
  const arr = Array.isArray(r) ? r : r?.nodes ?? [];
  return `${shape(r)} / ${arr.length} node(s)`;
});

await check("GET /api/hosts — inbound.configProfileUuid is nested", async () => {
  const r = await call("remnawave_call", { operation: "remnawave_get_hosts" });
  const arr = Array.isArray(r) ? r : r?.hosts ?? [];
  if (!arr.length) return "no hosts to inspect";
  const h = arr[0];
  const nested = h?.inbound && "configProfileUuid" in h.inbound;
  const topLevel = "configProfileUuid" in h;
  return `${arr.length} host(s); nested=${nested} topLevel=${topLevel}; keys=${shape(h)}`;
});

await check("GET /api/config-profiles returns full config objects", async () => {
  const r = await call("remnawave_call", { operation: "remnawave_get_config_profiles" });
  const arr = Array.isArray(r) ? r : r?.configProfiles ?? [];
  const first = arr[0];
  const hasInbounds = Boolean(first?.config?.inbounds || first?.inbounds);
  return `${arr.length} profile(s); hasInbounds=${hasInbounds}; keys=${shape(first)}`;
});

await check("GET /api/users paginated (size=1)", async () => {
  const r = await call("remnawave_call", { operation: "remnawave_get_users", params: { size: 1, start: 0 } });
  return `${shape(r)}; total=${r?.total ?? "n/a"}; returned=${(r?.users ?? []).length}`;
});

await check("GET /api/users with filters[] passthrough", async () => {
  const r = await call("remnawave_request_read", {
    path: "/api/users",
    query: { size: 1, start: 0, "filters[0][id]": "status", "filters[0][value]": "ACTIVE" },
  });
  return `${shape(r)}; total=${r?.total ?? "n/a"}`;
});

await check("GET /api/internal-squads", async () => {
  const r = await call("remnawave_call", { operation: "remnawave_get_internal_squads" });
  const arr = Array.isArray(r) ? r : r?.internalSquads ?? [];
  return `${arr.length} squad(s)`;
});

await check("GET /api/system/stats/nodes", async () => shape(await call("remnawave_request_read", { path: "/api/system/stats/nodes" })));

await check("GET /api/subscription-templates", async () => shape(await call("remnawave_request_read", { path: "/api/subscription-templates" })));

await check("GET /api/nodes/tags", async () => shape(await call("remnawave_request_read", { path: "/api/nodes/tags" })));

await check("404 carries message + errorCode", async () => {
  try {
    await call("remnawave_call", {
      operation: "remnawave_get_users_user_id",
      params: { userId: "00000000-0000-0000-0000-000000000000" },
    });
  } catch (err) {
    if (/HTTP 40[0-9]/.test(err.message)) return err.message.slice(0, 120);
    throw err;
  }
  throw new Error("expected a 4xx");
});

await check("GET /api/tokens/scopes (admin-JWT only — 403 is a pass)", async () => {
  try {
    return shape(await call("remnawave_request_read", { path: "/api/tokens/scopes" }));
  } catch (err) {
    if (/HTTP 40[13]/.test(err.message)) return "forbidden for API tokens, as documented";
    throw err;
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
