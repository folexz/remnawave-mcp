#!/usr/bin/env node
/**
 * write-check.mjs — verifies the mutating path against a real panel, then puts everything back.
 *
 * The read-only smoke test cannot prove that writes work: token routing, the throttle, the
 * confirm gate and partial-patch semantics only show themselves on a real POST/PATCH/DELETE.
 * This script exercises them on objects that no user is attached to, and restores the one
 * pre-existing object it touches.
 *
 * What it does, in order:
 *   1. creates an internal squad with no inbounds and no members, then deletes it
 *      (also proving the confirm gate refuses the delete until confirm=true);
 *   2. patches `serverDescription` on ONE host, verifies the change, writes the original
 *      value back and verifies the restore;
 *   3. measures the gap between two consecutive mutations against the configured throttle.
 *
 * It never touches users, config profiles, nodes, or any host field other than
 * serverDescription. It refuses to run without an explicit acknowledgement:
 *
 *   REMNAWAVE_BASE_URL=https://panel.example.com \
 *   REMNAWAVE_API_TOKEN_READ="$T" REMNAWAVE_API_TOKEN_WRITE="$T" \
 *   node scripts/write-check.mjs --i-understand-this-mutates [--host-uuid <uuid>]
 *
 * Output is shapes and booleans only — no payload values, no tokens.
 */
import { buildServer } from "../dist/index.js";

if (!process.argv.includes("--i-understand-this-mutates")) {
  console.error(
    "write-check mutates a live panel (creates and deletes a throwaway internal squad, and\n" +
      "temporarily rewrites serverDescription on one host).\n" +
      "Re-run with --i-understand-this-mutates if that is acceptable."
  );
  process.exit(2);
}

const env = {
  REMNAWAVE_BASE_URL: process.env.REMNAWAVE_BASE_URL,
  REMNAWAVE_API_TOKEN_READ: process.env.REMNAWAVE_API_TOKEN_READ || process.env.REMNAWAVE_API_TOKEN,
  REMNAWAVE_API_TOKEN_WRITE:
    process.env.REMNAWAVE_API_TOKEN_WRITE || process.env.REMNAWAVE_API_TOKEN,
};
if (!env.REMNAWAVE_BASE_URL || !env.REMNAWAVE_API_TOKEN_READ || !env.REMNAWAVE_API_TOKEN_WRITE) {
  console.error("Set REMNAWAVE_BASE_URL plus a read and a write token.");
  process.exit(2);
}

const { handlers, config } = buildServer(env);
const call = async (tool, args) => {
  const handler = handlers.get(tool);
  if (!handler) throw new Error(`tool '${tool}' not registered`);
  return handler(args ?? {});
};
const op = (operation, params) => call("remnawave_call", { operation, params });

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name} — ${detail}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}

console.log(`write-check against ${config.baseUrl} (throttle ${config.writeMinIntervalMs} ms)\n`);

/* -------------------------------------------------- 1. create/delete a squad */

const squadName = `rwmcp selftest ${Date.now() % 100000}`;
let squadUuid = null;

await check("POST /api/internal-squads creates a throwaway squad", async () => {
  const created = await op("remnawave_post_internal_squads", {
    body: { name: squadName, inbounds: [] },
  });
  squadUuid = created?.uuid ?? created?.internalSquad?.uuid ?? null;
  if (!squadUuid) throw new Error(`no uuid in response (keys: ${Object.keys(created ?? {})})`);
  return `created, membersCount=${created?.info?.membersCount ?? created?.membersCount ?? "n/a"}`;
});

await check("the new squad is visible in the list", async () => {
  const list = await op("remnawave_get_internal_squads");
  const squads = Array.isArray(list) ? list : (list?.internalSquads ?? []);
  const found = squads.some((s) => s.uuid === squadUuid);
  if (!found) throw new Error("squad not present after create");
  return `${squads.length} squads, target present`;
});

await check("DELETE is refused without confirm=true", async () => {
  if (!squadUuid) throw new Error("no squad to delete");
  try {
    await op("remnawave_delete_internal_squads_uuid", { uuid: squadUuid });
  } catch (err) {
    if (/confirm=true/.test(err.message)) return "gate held on a real delete";
    throw err;
  }
  throw new Error("delete went through WITHOUT confirm — gate is broken");
});

await check("DELETE with confirm=true removes the squad", async () => {
  const res = await op("remnawave_delete_internal_squads_uuid", {
    uuid: squadUuid,
    confirm: true,
  });
  return `isDeleted=${res?.isDeleted ?? JSON.stringify(res)}`;
});

await check("the squad is gone from the list", async () => {
  const list = await op("remnawave_get_internal_squads");
  const squads = Array.isArray(list) ? list : (list?.internalSquads ?? []);
  if (squads.some((s) => s.uuid === squadUuid)) throw new Error("squad still present");
  squadUuid = null;
  return `${squads.length} squads, target absent`;
});

/* ------------------------------------- 2. patch and restore one host's label */

const hostUuidArg = process.argv[process.argv.indexOf("--host-uuid") + 1];
let host = null;
let originalDescription;

await check("read the target host and record its original serverDescription", async () => {
  const list = await op("remnawave_get_hosts");
  const hosts = Array.isArray(list) ? list : (list?.hosts ?? []);
  host =
    (hostUuidArg && hostUuidArg !== "--host-uuid" ? hosts.find((h) => h.uuid === hostUuidArg) : null) ??
    hosts[0];
  if (!host) throw new Error("no hosts on this panel");
  originalDescription = host.serverDescription ?? null;
  return `host ${host.uuid.slice(0, 8)}…, serverDescription ${
    originalDescription === null ? "= null" : `is ${String(originalDescription).length} chars`
  }`;
});

const marker = `rwmcp check ${Date.now() % 10000}`; // well inside the 30-character cap
let mutatedAt = 0;

await check("PATCH /api/hosts accepts a partial body (uuid + one field)", async () => {
  const before = Date.now();
  await op("remnawave_patch_hosts", {
    body: { uuid: host.uuid, serverDescription: marker },
  });
  mutatedAt = Date.now();
  return `${mutatedAt - before} ms`;
});

await check("the change is visible on read-back", async () => {
  const list = await op("remnawave_get_hosts");
  const hosts = Array.isArray(list) ? list : (list?.hosts ?? []);
  const now = hosts.find((h) => h.uuid === host.uuid);
  if (now?.serverDescription !== marker) {
    throw new Error(`expected the marker, got ${JSON.stringify(now?.serverDescription)}`);
  }
  return "marker present";
});

await check("serverDescription longer than 30 characters is rejected", async () => {
  try {
    await op("remnawave_patch_hosts", {
      body: { uuid: host.uuid, serverDescription: "x".repeat(31) },
    });
  } catch (err) {
    return `panel refused: ${err.message.slice(0, 80)}`;
  }
  throw new Error("31 characters were accepted — the documented cap is wrong");
});

await check("RESTORE: the original serverDescription is written back", async () => {
  await op("remnawave_patch_hosts", {
    body: { uuid: host.uuid, serverDescription: originalDescription },
  });
  const list = await op("remnawave_get_hosts");
  const hosts = Array.isArray(list) ? list : (list?.hosts ?? []);
  const now = hosts.find((h) => h.uuid === host.uuid);
  const restored = (now?.serverDescription ?? null) === originalDescription;
  if (!restored) {
    throw new Error(
      `NOT RESTORED — expected ${JSON.stringify(originalDescription)}, ` +
        `got ${JSON.stringify(now?.serverDescription ?? null)}`
    );
  }
  return "original value confirmed back in place";
});

/* ------------------------------------------------------- 3. throttle timing */

await check("consecutive mutations are spaced by the configured interval", async () => {
  const stamps = [];
  for (let i = 0; i < 3; i++) {
    await op("remnawave_patch_hosts", {
      body: { uuid: host.uuid, serverDescription: originalDescription },
    });
    stamps.push(Date.now());
  }
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  const min = Math.min(...gaps);
  if (min < config.writeMinIntervalMs) {
    throw new Error(`gap ${min} ms < configured ${config.writeMinIntervalMs} ms`);
  }
  return `gaps ${gaps.join(", ")} ms >= ${config.writeMinIntervalMs} ms`;
});

/* ----------------------------------------------------------------- verdict */

const failed = results.filter((r) => !r.ok);
if (squadUuid) {
  console.log(`\n!! LEFTOVER: internal squad ${squadUuid} was created and not deleted.`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length || squadUuid ? 1 : 0);
