# remnawave-mcp

[![npm version](https://img.shields.io/npm/v/remnawave-mcp.svg)](https://www.npmjs.com/package/remnawave-mcp)
[![CI](https://github.com/folexz/remnawave-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/folexz/remnawave-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/remnawave-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/remnawave-mcp.svg)](https://nodejs.org)

An [MCP](https://modelcontextprotocol.io) server for the [Remnawave](https://remna.st) panel API.

```bash
npx -y remnawave-mcp   # configured via REMNAWAVE_BASE_URL + REMNAWAVE_API_TOKEN_READ/_WRITE
```

It covers **all 205 operations across 28 controllers** of Remnawave API **v3.3.2** — users,
nodes, hosts, config profiles, squads, subscriptions, node plugins, infra billing, system
stats — generated from the panel's own OpenAPI document rather than hand-written. Point a
newer spec at `npm run build-spec` and the tool surface follows.

## Highlights

- **Spec-driven.** `scripts/build-spec.ts` dereferences the OpenAPI document into a compact
  operation catalogue; every tool's input schema comes straight from the operation's
  parameters and request body. Nothing about the API is written by hand.
- **Bounded context cost.** 205 typed tools would cost ~39k tokens of `tools/list` on every
  request. The default profile exposes **5 tools** (~1.4k tokens) and still reaches every
  operation — see [Why not 205 tools](#why-not-205-tools).
- **Two-token least-privilege auth.** A read token and an optional write token. `GET` uses the
  read token; `POST/PATCH/PUT/DELETE` use the write token. Without a write token, mutating
  tools **are not registered at all** — the server is physically read-only.
- **Guard rails for a live panel.** Mutations are serialised with a minimum interval and
  retried with backoff, because every config write makes the panel push config to all nodes
  and restart Xray. Bulk and delete operations additionally require `confirm: true`.
- **Field notes baked in.** The gotchas below are attached to the operations they affect, so
  they appear in the tool description and in `remnawave_describe_operation` output.
- **Escape hatches.** `remnawave_request_read` / `remnawave_request_write` reach any path,
  including undocumented routes and query syntax OpenAPI cannot express.

## Requirements

- Node.js ≥ 18
- A Remnawave panel (3.x) reachable over HTTPS
- An API token from the panel: **Settings → API tokens**. Remnawave 3.x supports scoped
  tokens — mint one with read scopes and, if you want mutations, a second with write scopes.

## Install

The quick path is `npx` — see [Register with Claude Code](#register-with-claude-code). To run
from source:

```bash
git clone https://github.com/folexz/remnawave-mcp.git
cd remnawave-mcp
npm install
npm run build
```

## Configuration

All configuration is environment variables supplied by your MCP host. No files are read.

| Variable                           | Required | Default   | Description                                                                                |
| ---------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------ |
| `REMNAWAVE_BASE_URL`               | yes      | —         | Panel origin, e.g. `https://panel.example.com` (no `/api` suffix).                          |
| `REMNAWAVE_API_TOKEN_READ`         | yes      | —         | Read token. Alias: `REMNAWAVE_API_TOKEN`, so the panel's own `.env` name works.              |
| `REMNAWAVE_API_TOKEN_WRITE`        | no       | —         | Write token. Omit to run read-only.                                                          |
| `REMNAWAVE_TOOL_PROFILE`           | no       | `minimal` | `minimal` \| `core` \| `full` — how many typed tools to advertise.                          |
| `REMNAWAVE_CONTROLLERS`            | no       | —         | Comma-separated controller slugs; overrides the profile's typed-tool selection.              |
| `REMNAWAVE_MAX_SCHEMA_BYTES`       | no       | `2000`    | Input schemas larger than this are collapsed in `tools/list`.                                |
| `REMNAWAVE_WRITE_MIN_INTERVAL_MS`  | no       | `1500`    | Minimum gap between two mutations.                                                           |
| `REMNAWAVE_MAX_RETRIES`            | no       | `3`       | Retries on transport failures, 429 and 5xx.                                                  |
| `REMNAWAVE_TIMEOUT_MS`             | no       | `30000`   | Per-request timeout.                                                                         |
| `REMNAWAVE_SKIP_CONFIRM`           | no       | `0`       | `1` removes the `confirm: true` requirement on destructive operations.                       |

## Register with Claude Code

Read-only (recommended default):

```bash
claude mcp add remnawave --scope user \
  --env REMNAWAVE_BASE_URL=https://panel.example.com \
  --env REMNAWAVE_API_TOKEN_READ=your_read_token \
  -- npx -y remnawave-mcp@latest
```

With mutations enabled and typed tools for the everyday controllers:

```bash
claude mcp add remnawave --scope user \
  --env REMNAWAVE_BASE_URL=https://panel.example.com \
  --env REMNAWAVE_API_TOKEN_READ=your_read_token \
  --env REMNAWAVE_API_TOKEN_WRITE=your_write_token \
  --env REMNAWAVE_TOOL_PROFILE=core \
  -- npx -y remnawave-mcp@latest
```

`@latest` makes npx resolve the newest published version on each launch. To run a local build,
replace the command with `node /absolute/path/to/remnawave-mcp/dist/index.js`.

## Register with Claude Desktop / other MCP clients

```jsonc
{
  "mcpServers": {
    "remnawave": {
      "command": "npx",
      "args": ["-y", "remnawave-mcp@latest"],
      "env": {
        "REMNAWAVE_BASE_URL": "https://panel.example.com",
        "REMNAWAVE_API_TOKEN_READ": "your_read_token"
      }
    }
  }
}
```

## Why not 205 tools

`tools/list` is re-sent to the model on every request, so its serialized size is a permanent
context tax. Measured on this spec (`npx tsx scripts/tool-stats.ts`):

| Profile   | Tools (read+write) | `tools/list` | ≈ tokens | Tools (read-only) | ≈ tokens |
| --------- | ------------------ | ------------ | -------- | ----------------- | -------- |
| `minimal` | 5                  | 5.6 KB       | ~1.4k    | 4                 | ~1.2k    |
| `core`    | 91                 | 71 KB        | ~17.8k   | 38                | ~5.9k    |
| `full`    | 210                | 156 KB       | ~39k     | 92                | ~13.9k   |

Remnawave's DTOs are the reason `full` is so expensive: one dereferenced host object is ~30 KB
of JSON Schema on its own, because it embeds every inbound and security variant.

So the server does not choose between "one tool per operation" and "one blunt dispatcher" — it
ships both, and lets the profile decide how much is advertised:

1. **Catalogue tools (always on, 3 tools).** `remnawave_list_operations` browses and searches
   the catalogue and returns one compact line per operation; `remnawave_describe_operation`
   returns the complete JSON Schema plus field notes for one operation;
   `remnawave_call` executes any of the 205 by name. The usual loop is
   *list → describe → call*, and it costs the same 1.4k tokens no matter how big the API gets.
   This is the same lazy-loading idea an agent harness uses when it defers tool schemas.
2. **Typed tools (profile-selected).** One generated tool per operation for the controllers
   you actually work with — `core` covers users, nodes, hosts, config profiles, internal
   squads, system and the two bulk-action controllers; `full` covers everything; `minimal`
   none. Schemas over `REMNAWAVE_MAX_SCHEMA_BYTES` keep their top-level fields and drop the
   nesting, with a pointer to `remnawave_describe_operation` for the full version.
3. **Escape hatches (2 tools).** Raw GET and raw write for anything the spec misses.

Every route goes through the same executor, so the write gate, the destructive-confirm gate,
path templating and query handling behave identically whichever surface you use.

Pick a profile by taste: `minimal` if you have many MCP servers connected, `core` if you want
the everyday operations one call away, `full` if context is not a concern.

## Field notes — behaviour the spec does not document

All of these were hit against a live 3.3.2 panel and are attached to the affected operations
in the tool descriptions.

- **`PATCH /api/config-profiles` is a replace, not a patch.** The body is `{uuid, config}` and
  `config` must be the **complete, valid** Xray config. A fragment fails with
  `A061: Config doesn't have inbounds`. Correct sequence: `GET /api/config-profiles/{uuid}` →
  edit the returned `config` object in place → `PATCH` the whole thing back.
- **The panel does not answer on `127.0.0.1:3000`,** even from the panel host itself and even
  though `docker-proxy` is listening there (`curl` returns exit 52, empty reply). Always use
  the public HTTPS origin with a Bearer token.
- **Every response is wrapped in `{"response": ...}`.** This server unwraps it, so tool output
  is the payload itself.
- **A host binds to a profile through the nested `inbound.configProfileUuid`** (plus
  `inbound.configProfileInboundUuid`), *not* a top-level `configProfileUuid`. Verified against
  live hosts: nested present, top level absent.
- **A run of `PATCH`es will take the panel down.** Each config write pushes to every node and
  restarts Xray there; several in a row and the panel's own TLS listener stops answering. The
  client serialises mutations (`REMNAWAVE_WRITE_MIN_INTERVAL_MS`, default 1500 ms) and retries
  transport failures with exponential backoff and jitter. Do not defeat it by firing bulk
  updates in parallel.
- **`POST /api/subscription-templates` creates an empty template only.** The content is
  uploaded by a separate `PATCH /api/subscription-templates`. JSON and YAML bodies cannot be
  updated in the same call.
- **`serverDescription` on a host is capped at 30 characters** (confirmed by `maxLength` in the
  spec). It is also what makes a Hysteria2 host render properly in Happ instead of raw JSON.
- **`GET /api/tokens/scopes` is admin-JWT only** — an API token gets 401/403. Expected.
- Errors come back as `{message, errorCode}`; the `errorCode` (e.g. `A061`) is included in this
  server's error text.

## Tool coverage

Every controller is reachable through `remnawave_call` and the escape hatches. The
**typed** column shows which get individual tools under `REMNAWAVE_TOOL_PROFILE=core`.

| Controller slug                | Operations | Typed under `core` |
| ------------------------------ | ---------- | ------------------ |
| `users`                        | 17         | yes                |
| `node-plugins`                 | 18         | —                  |
| `nodes`                        | 15         | yes                |
| `infra-billing`                | 12         | —                  |
| `internal-squads`              | 12         | yes                |
| `system`                       | 12         | yes                |
| `users-bulk-actions`           | 10         | yes                |
| `config-profiles`              | 9          | yes                |
| `external-squads`              | 8          | —                  |
| `auth`                         | 7          | —                  |
| `bandwidth-stats`              | 7          | —                  |
| `connections`                  | 7          | —                  |
| `hosts`                        | 7          | yes                |
| `hwid-user-devices`            | 7          | —                  |
| `subscription-page-configs`    | 7          | —                  |
| `subscriptions`                | 7          | —                  |
| `subscription-template`        | 6          | —                  |
| `node-integrations`            | 5          | —                  |
| `passkeys`                     | 5          | —                  |
| `snippets`                     | 5          | —                  |
| `api-tokens`                   | 4          | —                  |
| `hosts-bulk-actions`           | 4          | yes                |
| `metadata`                     | 4          | —                  |
| `public-subscription`          | 3          | —                  |
| `remnawave-settings`           | 2          | —                  |
| `subscription-request-history` | 2          | —                  |
| `subscription-settings`        | 2          | —                  |
| `keygen`                       | 1          | —                  |
| **Total**                      | **205**    |                    |

Run `remnawave_list_operations` against a live server for the exact, current set.

## Examples

Browse and call without any typed tools:

```jsonc
// 1. What is there?
{ "tool": "remnawave_list_operations", "arguments": { "controller": "nodes" } }

// 2. What does it take?
{ "tool": "remnawave_describe_operation",
  "arguments": { "operation": "remnawave_post_nodes_uuid_actions_restart" } }

// 3. Do it.
{ "tool": "remnawave_call",
  "arguments": { "operation": "remnawave_post_nodes_uuid_actions_restart",
                 "params": { "uuid": "…" } } }
```

Editing a config profile safely (the `A061` trap):

```jsonc
// Read the whole profile first — PATCH replaces the config wholesale.
{ "tool": "remnawave_call",
  "arguments": { "operation": "remnawave_get_config_profiles_uuid", "params": { "uuid": "…" } } }

// Send the full, edited config back.
{ "tool": "remnawave_call",
  "arguments": { "operation": "remnawave_patch_config_profiles",
                 "params": { "body": { "uuid": "…", "config": { /* complete Xray config */ } } } } }
```

Query syntax the spec cannot express:

```jsonc
{ "tool": "remnawave_request_read",
  "arguments": { "path": "/api/users",
                 "query": { "size": 25, "start": 0,
                            "filters[0][id]": "status", "filters[0][value]": "ACTIVE" } } }
```

## Testing

```bash
npm run build
npm run smoke        # offline: catalogue, write gate, confirm gate, schema collapsing
```

With a panel reachable and a **read** token in the environment, the same script also runs
live read-only checks (never a mutation):

```bash
REMNAWAVE_BASE_URL=https://panel.example.com \
REMNAWAVE_API_TOKEN_READ="$REMNAWAVE_API_TOKEN" \
npm run smoke
```

Run it where the token already lives (e.g. on the panel host) so the secret never travels. The
script prints shapes — types, key names, array lengths — and never payload values, so its
output is safe to paste into an issue.

Guard-rail checks deliberately point at `http://127.0.0.1:9`, so a gate that ever failed open
could not reach a real panel.

## Inspect locally

```bash
REMNAWAVE_BASE_URL=https://panel.example.com REMNAWAVE_API_TOKEN_READ=xxx npm run inspect
```

## Updating the API spec

Drop a newer OpenAPI document at `spec/remnawave-openapi.json` (the panel serves it at
`/openapi.json` / the docs page) and rebuild:

```bash
npm run build-spec   # -> spec/remnawave-operations.json
npm run build
```

Only the derived catalogue is published to npm; the 1.5 MB raw document stays in the repo.
CI fails if the catalogue is out of date with the spec.

## Releasing (maintainers)

Publishing is automated by `.github/workflows/release.yml`, which runs on any pushed `vX.Y.Z`
tag and publishes via [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC) — no token or secret required, with provenance generated automatically.

One-time setup on npmjs.com → package `remnawave-mcp` → Settings → Trusted Publisher: add a
GitHub Actions publisher with repository `folexz/remnawave-mcp` and workflow `release.yml`.

```bash
npm version patch --no-git-tag-version   # bump via a PR if main is protected
git tag v0.1.1 && git push origin v0.1.1 # triggers Release -> npm publish
```

The workflow fails fast if the tag does not match `package.json`.

## Security notes

- Tokens are read from the environment only and are never logged. Logs go to stderr; stdout is
  the MCP JSON-RPC channel.
- Prefer configuring only `REMNAWAVE_API_TOKEN_READ`. Mutating tools do not exist without a
  write token, so a compromised or confused client cannot change the panel.
- Subscription endpoints return working client configs. Treat their output as secret.
- Never commit real tokens. `.env` is gitignored; `.env.example` shows the shape.

## Known limitations

- Local validation checks required arguments and required bodies only; deep body validation is
  left to the panel, which returns a precise `errorCode`.
- `GET /api/users/stream` returns newline-delimited JSON and is returned as a single string.
- Auth and passkey endpoints are in the catalogue for completeness but require an admin JWT;
  an API token cannot call most of them.
- The Prometheus basic-auth metrics endpoint is not part of this spec and is not exposed.
- The tool catalogue tracks the shipped spec (v3.3.2). A panel on a different minor version may
  expose routes it does not describe — that is what the escape hatches are for.

## License

MIT — see [LICENSE](./LICENSE).
