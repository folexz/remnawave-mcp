/**
 * build-spec — turns the raw Remnawave OpenAPI document into the compact, runtime-ready
 * operation catalogue that ships with the package.
 *
 *   spec/remnawave-openapi.json    (input, ~1.5 MB, repo only — not published to npm)
 *        |
 *        v
 *   spec/remnawave-operations.json (output, ~300 KB, published)
 *
 * The transformation itself lives in spec-transform.ts and is unit-tested; this file is the
 * I/O and reporting shell around it. After writing, it diffs the new catalogue against the
 * previous one and prints what changed, so a spec bump can never silently drop or rename a
 * tool that an MCP client already references.
 *
 * Regenerate after dropping in a newer spec:    npm run build-spec
 * Fetch the newest spec and rebuild in one go:  npm run update-spec
 *
 * Flags:
 *   --strict   exit non-zero when operations disappear or are renamed (used by automation)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCatalogue, diffCatalogues, type Catalogue } from "./spec-transform.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const IN_PATH = join(ROOT, "spec", "remnawave-openapi.json");
const OUT_PATH = join(ROOT, "spec", "remnawave-operations.json");

function readPrevious(): Catalogue | null {
  if (!existsSync(OUT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(OUT_PATH, "utf8")) as Catalogue;
  } catch {
    return null;
  }
}

function section(label: string, items: string[]): void {
  if (!items.length) return;
  console.log(`  ${label} (${items.length}):`);
  for (const item of items.slice(0, 40)) console.log(`    ${item}`);
  if (items.length > 40) console.log(`    ... and ${items.length - 40} more`);
}

function main(): void {
  const spec = JSON.parse(readFileSync(IN_PATH, "utf8"));
  const previous = readPrevious();
  const catalogue = buildCatalogue(spec);

  writeFileSync(OUT_PATH, JSON.stringify(catalogue, null, 1) + "\n");

  const bytes = JSON.stringify(catalogue).length;
  const methods = catalogue.operations.reduce<Record<string, number>>((acc, o) => {
    acc[o.method] = (acc[o.method] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    `build-spec: ${catalogue.apiTitle} -> ${catalogue.operationCount} operations, ` +
      `${catalogue.controllers.length} controllers, ${(bytes / 1024).toFixed(0)} KB ` +
      `-> spec/remnawave-operations.json`
  );
  console.log(
    `  methods: ${Object.entries(methods)
      .sort()
      .map(([m, n]) => `${m.toUpperCase()}=${n}`)
      .join(" ")}` + `  admin-JWT-only: ${catalogue.operations.filter((o) => o.adminJwtOnly).length}`
  );

  if (!previous) {
    console.log("  diff: no previous catalogue — treating every operation as new");
    return;
  }

  const diff = diffCatalogues(previous, catalogue);
  if (diff.versionChanged) {
    console.log(`  diff: API version ${previous.apiVersion} -> ${catalogue.apiVersion}`);
  }
  if (!diff.added.length && !diff.removed.length && !diff.renamed.length && !diff.reshaped.length) {
    console.log("  diff: no operation changes");
    return;
  }

  section("REMOVED — tools that will disappear", diff.removed);
  section("RENAMED — tool name changed, same route", diff.renamed);
  section("added", diff.added);
  section("schema changed", diff.reshaped);

  if (diff.breaking && process.argv.includes("--strict")) {
    console.error(
      "::error::operations were removed or renamed — review the diff above before releasing"
    );
    process.exit(1);
  }
}

main();
