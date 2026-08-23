/**
 * Unit tests for the runtime guard rails.
 *
 * Everything here is offline. Where a test needs a client, it points at 127.0.0.1:9 (discard)
 * with retries disabled, so a gate that ever failed open dies locally rather than reaching a
 * panel.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseNdjson, RemnawaveClient, RemnawaveError } from "../src/client.js";
import { loadConfig, type Config } from "../src/config.js";
import { collapseSchema, formatOperationLine, loadCatalogue, resolveOperation, buildIndex, searchOperations } from "../src/spec.js";
import { executeOperation } from "../src/tools/executor.js";
import { buildGeneratedTools } from "../src/tools/generated.js";
import { buildGenericTools } from "../src/tools/generic.js";

const SANDBOX = "http://127.0.0.1:9";

function cfg(extra: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    REMNAWAVE_BASE_URL: SANDBOX,
    REMNAWAVE_API_TOKEN_READ: "read-token",
    REMNAWAVE_MAX_RETRIES: "0",
    REMNAWAVE_TIMEOUT_MS: "1000",
    ...extra,
  } as NodeJS.ProcessEnv);
}

const catalogue = loadCatalogue();
const index = buildIndex(catalogue);
const find = (name: string) => {
  const op = resolveOperation(index, name);
  if (!op) throw new Error(`fixture operation ${name} missing from the catalogue`);
  return op;
};

/* ------------------------------------------------------------------ config */

test("loadConfig requires a base URL and a read token", () => {
  assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /REMNAWAVE_BASE_URL is required/);
  assert.throws(
    () => loadConfig({ REMNAWAVE_BASE_URL: SANDBOX } as NodeJS.ProcessEnv),
    /REMNAWAVE_API_TOKEN_READ is required/
  );
});

test("loadConfig accepts REMNAWAVE_API_TOKEN as the read-token alias", () => {
  const c = loadConfig({
    REMNAWAVE_BASE_URL: SANDBOX,
    REMNAWAVE_API_TOKEN: "panel-env-token",
  } as NodeJS.ProcessEnv);
  assert.equal(c.readToken, "panel-env-token");
  assert.equal(c.canWrite, false);
});

test("loadConfig strips a trailing /api from the base URL", () => {
  const c = cfg({ REMNAWAVE_BASE_URL: "https://panel.example.com/api/" });
  assert.equal(c.baseUrl, "https://panel.example.com");
});

test("loadConfig rejects an unknown tool profile", () => {
  assert.throws(() => cfg({ REMNAWAVE_TOOL_PROFILE: "everything" }), /minimal\|core\|full/);
});

test("profiles select controllers: minimal none, core a subset, full all", () => {
  assert.deepEqual(cfg({ REMNAWAVE_TOOL_PROFILE: "minimal" }).controllers, []);
  assert.ok((cfg({ REMNAWAVE_TOOL_PROFILE: "core" }).controllers ?? []).includes("users"));
  assert.equal(cfg({ REMNAWAVE_TOOL_PROFILE: "full" }).controllers, null);
  assert.deepEqual(cfg({ REMNAWAVE_CONTROLLERS: "nodes, hosts " }).controllers, ["nodes", "hosts"]);
});

/* ------------------------------------------------------------- write gate */

test("a mutating operation is refused without a write token", async () => {
  const config = cfg();
  const client = new RemnawaveClient(config);
  await assert.rejects(
    () => executeOperation(client, config, find("remnawave_delete_hosts_uuid"), { uuid: "x", confirm: true }),
    /read-only/
  );
});

test("mutating tools are not registered without a write token", () => {
  const config = cfg({ REMNAWAVE_TOOL_PROFILE: "full" });
  const { tools } = buildGeneratedTools(new RemnawaveClient(config), config, catalogue.operations);
  assert.equal(tools.filter((t) => t.annotations?.readOnlyHint === false).length, 0);
  assert.ok(tools.length > 60, "read-only tools should still be registered");
});

test("the write escape hatch appears only with a write token", () => {
  const readOnly = cfg();
  assert.ok(!buildGenericTools(new RemnawaveClient(readOnly), readOnly).handlers.has("remnawave_request_write"));
  const writable = cfg({ REMNAWAVE_API_TOKEN_WRITE: "w" });
  assert.ok(buildGenericTools(new RemnawaveClient(writable), writable).handlers.has("remnawave_request_write"));
});

test("the client refuses to spend the read token on a write", async () => {
  const config = cfg();
  await assert.rejects(
    () => new RemnawaveClient(config).request("POST", "/api/users", { mode: "write" }),
    (err: RemnawaveError) => /REMNAWAVE_API_TOKEN_WRITE is not configured/.test(err.message)
  );
});

/* ----------------------------------------------------------- confirm gate */

test("a destructive operation needs confirm=true", async () => {
  const config = cfg({ REMNAWAVE_API_TOKEN_WRITE: "w" });
  const client = new RemnawaveClient(config);
  await assert.rejects(
    () => executeOperation(client, config, find("remnawave_post_users_bulk_delete"), { body: { uuids: [] } }),
    /confirm=true/
  );
});

test("REMNAWAVE_SKIP_CONFIRM removes the confirm requirement from the schema", () => {
  const gated = cfg({ REMNAWAVE_API_TOKEN_WRITE: "w", REMNAWAVE_TOOL_PROFILE: "core" });
  const gatedTools = buildGeneratedTools(new RemnawaveClient(gated), gated, catalogue.operations).tools;
  const gatedTool = gatedTools.find((t) => t.name === "remnawave_post_users_bulk_delete");
  assert.ok(gatedTool?.inputSchema.required.includes("confirm"));

  const open = cfg({
    REMNAWAVE_API_TOKEN_WRITE: "w",
    REMNAWAVE_TOOL_PROFILE: "core",
    REMNAWAVE_SKIP_CONFIRM: "1",
  });
  const openTool = buildGeneratedTools(new RemnawaveClient(open), open, catalogue.operations).tools.find(
    (t) => t.name === "remnawave_post_users_bulk_delete"
  );
  assert.ok(!(openTool?.inputSchema.required ?? []).includes("confirm"));
});

test("a plain read is never gated", () => {
  const op = find("remnawave_get_users");
  assert.equal(op.mutating, false);
  assert.equal(op.destructive, false);
});

/* --------------------------------------------------------- admin-JWT gate */

test("admin-JWT-only operations are refused before any request is sent", async () => {
  const config = cfg({ REMNAWAVE_API_TOKEN_WRITE: "w" });
  const client = new RemnawaveClient(config);
  await assert.rejects(
    () => executeOperation(client, config, find("remnawave_get_tokens"), {}),
    /logged-in admin session \(JWT\)/
  );
  await assert.rejects(
    () => executeOperation(client, config, find("remnawave_post_auth_login"), { body: {} }),
    /logged-in admin session \(JWT\)/
  );
});

test("REMNAWAVE_ALLOW_ADMIN_JWT_OPS lifts the admin-JWT gate", async () => {
  const config = cfg({ REMNAWAVE_ALLOW_ADMIN_JWT_OPS: "1" });
  const client = new RemnawaveClient(config);
  // The gate is lifted, so it now fails at the network layer instead — which is the point.
  await assert.rejects(
    () => executeOperation(client, config, find("remnawave_get_tokens"), {}),
    /Request failed/
  );
});

test("the catalogue flags exactly the session and API-token controllers", () => {
  const flagged = catalogue.operations.filter((o) => o.adminJwtOnly);
  const slugs = new Set(flagged.map((o) => o.controllerSlug));
  assert.deepEqual([...slugs].sort(), ["api-tokens", "auth", "passkeys"]);
});

/* ------------------------------------------------- argument preprocessing */

test("a missing path parameter is caught locally", async () => {
  const config = cfg();
  await assert.rejects(
    () => executeOperation(new RemnawaveClient(config), config, find("remnawave_get_users_user_id"), {}),
    /Missing required path parameter 'userId'/
  );
});

test("a missing required body is caught locally", async () => {
  const config = cfg({ REMNAWAVE_API_TOKEN_WRITE: "w" });
  await assert.rejects(
    () => executeOperation(new RemnawaveClient(config), config, find("remnawave_post_users"), {}),
    /requires a 'body'/
  );
});

/* ------------------------------------------------------ schema collapsing */

test("collapseSchema leaves a small schema untouched", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  assert.deepEqual(collapseSchema(schema, 4000, "op"), schema);
});

test("collapseSchema keeps field names and points at describe", () => {
  const big = {
    type: "object",
    required: ["body"],
    properties: {
      body: {
        type: "object",
        required: ["remark"],
        properties: Object.fromEntries(
          Array.from({ length: 60 }, (_, i) => [`field${i}`, { type: "string", description: "x".repeat(40) }])
        ),
      },
    },
  };
  const collapsed = collapseSchema(big, 500, "remnawave_post_hosts");
  assert.ok(JSON.stringify(collapsed).length < JSON.stringify(big).length);
  assert.deepEqual(collapsed.required, ["body"]);
  assert.match(collapsed.properties.body.description, /Fields: field0, field1/);
  assert.match(collapsed.properties.body.description, /Required: remark/);
  assert.match(collapsed.properties.body.description, /remnawave_describe_operation/);
});

test("the real host schema collapses by more than an order of magnitude", () => {
  const op = find("remnawave_post_hosts");
  const collapsed = JSON.stringify(collapseSchema(op.inputSchema, 2000, op.name)).length;
  assert.ok(op.schemaBytes > 20000, `expected a big schema, got ${op.schemaBytes}`);
  assert.ok(collapsed * 10 < op.schemaBytes, `${collapsed} vs ${op.schemaBytes}`);
});

/* ----------------------------------------------------- catalogue lookups */

test("an operation resolves by tool name, operationId and route", () => {
  const byName = resolveOperation(index, "remnawave_patch_config_profiles");
  assert.ok(byName);
  assert.equal(resolveOperation(index, byName.operationId)?.name, byName.name);
  assert.equal(resolveOperation(index, "patch /api/config-profiles")?.name, byName.name);
  assert.equal(resolveOperation(index, "PATCH /API/CONFIG-PROFILES")?.name, byName.name);
  assert.equal(resolveOperation(index, "nope_not_here"), undefined);
});

test("search narrows by controller, method and mutability", () => {
  assert.ok(searchOperations(catalogue.operations, { controller: "hosts" }).length === 7);
  assert.ok(searchOperations(catalogue.operations, { method: "delete" }).length === 21);
  assert.ok(searchOperations(catalogue.operations, { mutating: false }).length === 88);
  const bulkSquad = searchOperations(catalogue.operations, { query: "bulk squad" });
  assert.ok(bulkSquad.length > 0 && bulkSquad.every((o) => /bulk/.test(o.name)));
});

test("an operation line advertises its arguments and its risk flags", () => {
  const line = formatOperationLine(find("remnawave_post_users_bulk_delete"));
  assert.match(line, /WRITE\/DESTRUCTIVE/);
  const jwtLine = formatOperationLine(find("remnawave_get_tokens"));
  assert.match(jwtLine, /ADMIN-JWT-ONLY/);
});

/* ------------------------------------------------------------------ NDJSON */

test("parseNdjson turns a stream body into records", () => {
  const body = '{"a":1}\n{"a":2}\n{"a":3}\n';
  assert.deepEqual(parseNdjson(body), [{ a: 1 }, { a: 2 }, { a: 3 }]);
});

test("parseNdjson tolerates blank lines and a missing trailing newline", () => {
  assert.deepEqual(parseNdjson('{"a":1}\n\n{"a":2}'), [{ a: 1 }, { a: 2 }]);
});

test("parseNdjson honours an ndjson content type for a single record", () => {
  assert.deepEqual(parseNdjson('{"a":1}', "application/x-ndjson"), [{ a: 1 }]);
  assert.equal(parseNdjson('{"a":1}'), null, "one line without the header is a normal document");
});

test("parseNdjson refuses prose instead of mangling it", () => {
  assert.equal(parseNdjson("upstream timeout\nplease retry"), null);
  assert.equal(parseNdjson('{"a":1}\nnot json'), null);
});

test("parseNdjson returns an empty array for an empty declared stream", () => {
  assert.deepEqual(parseNdjson("", "application/x-ndjson"), []);
  assert.equal(parseNdjson(""), null);
});
