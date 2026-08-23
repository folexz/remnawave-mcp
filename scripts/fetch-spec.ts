/**
 * fetch-spec — pull the newest Remnawave OpenAPI document and rebuild the catalogue.
 *
 *   npm run update-spec              # from the canonical CDN copy
 *   npm run update-spec -- --strict  # fail if operations disappeared or were renamed
 *
 * Source, in order of preference:
 *   1. --url <u> / REMNAWAVE_SPEC_URL
 *   2. https://cdn.remna.st/docs/openapi.json — published by the panel's own
 *      "Build&Push OpenAPI Specs" workflow on every upstream tag.
 *
 * A panel instance does NOT serve its spec by default: docs are off unless the deployment
 * enables them, and even then Swagger lives at /backend-tools/swagger, which the usual
 * reverse proxy does not route. The CDN copy is the dependable source.
 *
 * The download is written to spec/remnawave-openapi.json only after it parses as an OpenAPI
 * document with a non-empty `paths`, so a captive portal or an error page cannot clobber a
 * working spec.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SPEC_PATH = join(ROOT, "spec", "remnawave-openapi.json");
const DEFAULT_URL = "https://cdn.remna.st/docs/openapi.json";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = argValue("--url") ?? process.env.REMNAWAVE_SPEC_URL ?? DEFAULT_URL;
  console.log(`fetch-spec: GET ${url}`);

  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "remnawave-mcp/fetch-spec" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const text = await res.text();
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`response is not JSON (${text.length} bytes) — refusing to overwrite the spec`);
  }
  const pathCount = Object.keys(doc?.paths ?? {}).length;
  if (!doc?.openapi || pathCount === 0) {
    throw new Error("response is not an OpenAPI document with paths — refusing to overwrite");
  }

  let previousVersion = "(none)";
  try {
    previousVersion = JSON.parse(readFileSync(SPEC_PATH, "utf8")).info?.version ?? "(unknown)";
  } catch {
    /* first run */
  }

  writeFileSync(SPEC_PATH, text.endsWith("\n") ? text : `${text}\n`);
  console.log(
    `fetch-spec: ${doc.info?.title ?? "spec"} — version ${previousVersion} -> ` +
      `${doc.info?.version ?? "?"}, ${pathCount} paths, ${(text.length / 1024).toFixed(0)} KB`
  );

  // Rebuild the catalogue; build-spec prints the operation diff and honours --strict.
  const strict = process.argv.includes("--strict") ? ["--strict"] : [];
  const build = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(__dirname, "build-spec.ts"), ...strict],
    { stdio: "inherit", cwd: ROOT }
  );
  process.exit(build.status ?? 1);
}

main().catch((err) => {
  console.error(`fetch-spec failed: ${(err as Error).message}`);
  process.exit(1);
});
