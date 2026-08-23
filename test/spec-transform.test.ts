/**
 * Unit tests for the spec -> catalogue transformation.
 *
 * These cover the places that break quietly: $ref expansion through recursive DTOs, tool-name
 * derivation (length budget and collisions) and the catalogue diff that guards a spec bump.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCatalogue,
  controllerSlug,
  dereference,
  diffCatalogues,
  isAdminJwtOnly,
  isDestructivePath,
  MAX_TOOL_NAME,
  pathSlug,
  toolName,
} from "../scripts/spec-transform.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("dereference inlines a $ref", () => {
  const schemas = { User: { type: "object", properties: { id: { type: "string" } } } };
  const out = dereference({ $ref: "#/components/schemas/User" }, schemas);
  assert.deepEqual(out, schemas.User);
});

test("dereference keeps sibling keywords next to a $ref", () => {
  const schemas = { User: { type: "object" } };
  const out = dereference(
    { $ref: "#/components/schemas/User", description: "the user", nullable: true },
    schemas
  );
  assert.equal(out.type, "object");
  assert.equal(out.description, "the user");
  assert.equal(out.nullable, true);
});

test("dereference terminates on a self-recursive schema", () => {
  const schemas = {
    Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } },
  };
  const out = dereference({ $ref: "#/components/schemas/Node" }, schemas);
  assert.equal(out.properties.child.additionalProperties, true);
  assert.match(out.properties.child.description, /Recursive reference to Node/);
});

test("dereference terminates on a mutually recursive cycle", () => {
  const schemas = {
    A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } },
    B: { type: "object", properties: { a: { $ref: "#/components/schemas/A" } } },
  };
  const out = dereference({ $ref: "#/components/schemas/A" }, schemas);
  assert.match(out.properties.b.properties.a.description, /Recursive reference to A/);
});

test("dereference reports an unresolved $ref instead of throwing", () => {
  const out = dereference({ $ref: "#/components/schemas/Missing" }, {});
  assert.match(out.description, /Unresolved reference/);
});

test("dereference walks arrays and nested objects", () => {
  const schemas = { X: { type: "integer" } };
  const out = dereference(
    { oneOf: [{ $ref: "#/components/schemas/X" }, { type: "null" }] },
    schemas
  );
  assert.deepEqual(out.oneOf[0], { type: "integer" });
});

test("pathSlug strips /api, braces and camelCase", () => {
  assert.equal(pathSlug("/api/users/{userId}/actions/reset-traffic"), "users_user_id_actions_reset_traffic");
  assert.equal(pathSlug("/api/config-profiles"), "config_profiles");
  assert.equal(pathSlug("/api/thing/"), "thing", "a trailing slash must not leak into the name");
});

test("toolName stays inside the 64-character budget", () => {
  const long = toolName(
    "get",
    "/api/bandwidth-stats/internal-squads/{squadUuid}/users/{userId}/usage",
    ["squadUuid", "userId"]
  );
  assert.ok(long.length <= MAX_TOOL_NAME, `${long} is ${long.length} chars`);
  assert.ok(long.startsWith("remnawave_get_bandwidth_stats"));
});

test("toolName is deterministic", () => {
  const a = toolName("delete", "/api/internal-squads/{uuid}/bulk-actions/remove-many-users", ["uuid"]);
  const b = toolName("delete", "/api/internal-squads/{uuid}/bulk-actions/remove-many-users", ["uuid"]);
  assert.equal(a, b);
});

test("controllerSlug normalises tags and keeps public routes distinct", () => {
  assert.equal(controllerSlug("Users Controller"), "users");
  assert.equal(controllerSlug("[Protected] Subscriptions Controller"), "subscriptions");
  assert.equal(controllerSlug("[Public] Subscription Controller"), "public-subscription");
  assert.equal(controllerSlug("HWID User Devices Controller"), "hwid-user-devices");
});

test("isDestructivePath catches bulk and fleet-wide routes", () => {
  assert.ok(isDestructivePath("/api/users/bulk/delete"));
  assert.ok(isDestructivePath("/api/nodes/bulk-actions"));
  assert.ok(isDestructivePath("/api/hwid/devices/delete-all"));
  assert.ok(isDestructivePath("/api/nodes/actions/restart-all"));
  assert.ok(isDestructivePath("/api/node-plugins/torrent-blocker/truncate"));
  assert.ok(!isDestructivePath("/api/users"));
  assert.ok(!isDestructivePath("/api/nodes/{uuid}/actions/restart"));
});

test("isAdminJwtOnly flags session controllers and API-key-forbidden prose", () => {
  assert.ok(isAdminJwtOnly({}, "auth"));
  assert.ok(isAdminJwtOnly({}, "passkeys"));
  assert.ok(
    isAdminJwtOnly(
      { description: 'This endpoint is forbidden to use via "API-key". Admin JWT-token only.' },
      "api-tokens"
    )
  );
  assert.ok(!isAdminJwtOnly({ description: "Get all users" }, "users"));
});

test("buildCatalogue rejects a duplicate tool name instead of losing an operation", () => {
  const spec = {
    info: { title: "t", version: "1" },
    openapi: "3.0.0",
    paths: {
      "/api/thing-x": { get: { tags: ["T Controller"], operationId: "a" } },
      "/api/thing_x": { get: { tags: ["T Controller"], operationId: "b" } },
    },
  };
  assert.throws(() => buildCatalogue(spec), /Duplicate tool name/);
});

test("buildCatalogue marks undeclared path parameters as required", () => {
  const spec = {
    info: { title: "t", version: "1" },
    openapi: "3.0.0",
    paths: { "/api/thing/{uuid}": { get: { tags: ["T Controller"], operationId: "a" } } },
  };
  const op = buildCatalogue(spec).operations[0];
  assert.deepEqual(op.pathParams, ["uuid"]);
  assert.ok(op.inputSchema.required.includes("uuid"));
});

test("buildCatalogue ignores non-HTTP keys such as parameters and servers", () => {
  const spec = {
    info: { title: "t", version: "1" },
    openapi: "3.0.0",
    paths: {
      "/api/thing": {
        parameters: [{ name: "x", in: "query" }],
        servers: [],
        get: { tags: ["T Controller"], operationId: "a" },
      },
    },
  };
  assert.equal(buildCatalogue(spec).operationCount, 1);
});

test("the shipped spec produces 205 unique, budget-compliant tool names", () => {
  const spec = JSON.parse(readFileSync(join(ROOT, "spec", "remnawave-openapi.json"), "utf8"));
  const catalogue = buildCatalogue(spec);
  assert.equal(catalogue.operationCount, 205);
  assert.equal(catalogue.controllers.length, 28);

  const names = catalogue.operations.map((o) => o.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  for (const name of names) {
    assert.ok(name.length <= MAX_TOOL_NAME, `${name} is ${name.length} chars`);
    assert.match(name, /^remnawave_[a-z0-9_]+$/);
  }
  assert.equal(
    catalogue.controllers.reduce((n, c) => n + c.count, 0),
    205
  );
});

test("the built catalogue on disk matches a fresh build", () => {
  const spec = JSON.parse(readFileSync(join(ROOT, "spec", "remnawave-openapi.json"), "utf8"));
  const onDisk = JSON.parse(readFileSync(join(ROOT, "spec", "remnawave-operations.json"), "utf8"));
  assert.deepEqual(
    buildCatalogue(spec).operations.map((o) => o.name),
    onDisk.operations.map((o: { name: string }) => o.name),
    "run `npm run build-spec` and commit the result"
  );
});

const op = (name: string, method: string, path: string, schemaBytes = 100) => ({
  name,
  method,
  path,
  schemaBytes,
});

test("diffCatalogues reports a removed operation as breaking", () => {
  const diff = diffCatalogues(
    { apiVersion: "1", operations: [op("remnawave_get_a", "get", "/api/a")] },
    { apiVersion: "1", operations: [] }
  );
  assert.equal(diff.removed.length, 1);
  assert.ok(diff.breaking);
});

test("diffCatalogues reports a rename rather than add + remove", () => {
  const diff = diffCatalogues(
    { apiVersion: "1", operations: [op("remnawave_get_a", "get", "/api/a")] },
    { apiVersion: "1", operations: [op("remnawave_get_alpha", "get", "/api/a")] }
  );
  assert.deepEqual(diff.renamed, ["remnawave_get_a -> remnawave_get_alpha"]);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.added.length, 0);
  assert.ok(diff.breaking);
});

test("diffCatalogues treats a brand-new route as a non-breaking addition", () => {
  const diff = diffCatalogues(
    { apiVersion: "1", operations: [] },
    { apiVersion: "2", operations: [op("remnawave_get_b", "get", "/api/b")] }
  );
  assert.equal(diff.added.length, 1);
  assert.ok(diff.versionChanged);
  assert.ok(!diff.breaking);
});

test("diffCatalogues notices a reshaped body but does not call it breaking", () => {
  const diff = diffCatalogues(
    { apiVersion: "1", operations: [op("remnawave_post_a", "post", "/api/a", 100)] },
    { apiVersion: "1", operations: [op("remnawave_post_a", "post", "/api/a", 900)] }
  );
  assert.equal(diff.reshaped.length, 1);
  assert.ok(!diff.breaking);
});

test("diffCatalogues ignores schema noise below the threshold", () => {
  const diff = diffCatalogues(
    { apiVersion: "1", operations: [op("remnawave_post_a", "post", "/api/a", 100)] },
    { apiVersion: "1", operations: [op("remnawave_post_a", "post", "/api/a", 140)] }
  );
  assert.equal(diff.reshaped.length, 0);
});
