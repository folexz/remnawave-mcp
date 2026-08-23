// Регрессия: при установке через npm/npx бинарь оказывается симлинком.
// Раньше сравнение import.meta.url с process.argv[1] по сырой строке не совпадало,
// main() не вызывался, и сервер молча выходил с кодом 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(import.meta.dirname, "..", "dist", "index.js");

function startVia(target) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [target], {
      env: {
        ...process.env,
        REMNAWAVE_BASE_URL: "https://panel.example.com",
        REMNAWAVE_API_TOKEN_READ: "test-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => {
      err += d;
      if (err.includes("ready against")) {
        p.kill();
        done(err);
      }
    });
    setTimeout(() => {
      p.kill();
      done(err);
    }, 8000);
  });
}

test("стартует при прямом запуске", async () => {
  const err = await startVia(DIST);
  assert.match(err, /ready against/, "сервер должен объявить готовность");
});

test("стартует через симлинк (сценарий npx)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rwmcp-"));
  const link = join(dir, "remnawave-mcp");
  try {
    symlinkSync(DIST, link);
    const err = await startVia(link);
    assert.match(err, /ready against/, "сервер обязан стартовать и через симлинк");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
