# remnawave-mcp

[![npm version](https://img.shields.io/npm/v/@folexz/remnawave-mcp.svg)](https://www.npmjs.com/package/@folexz/remnawave-mcp)
[![CI](https://github.com/folexz/remnawave-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/folexz/remnawave-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@folexz/remnawave-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@folexz/remnawave-mcp.svg)](https://nodejs.org)

An [MCP](https://modelcontextprotocol.io) server for the [Remnawave](https://remna.st) panel API.

> Published under the `@folexz` scope: the unscoped `remnawave-mcp` name on npm belongs to an
> unrelated project that targets Remnawave 2.7.4 and does not work with 2.8.0+.

```bash
npx -y @folexz/remnawave-mcp   # configured via REMNAWAVE_BASE_URL + REMNAWAVE_API_TOKEN_READ/_WRITE
```

It covers **all 205 operations across 28 controllers** of Remnawave API **v3.3.2** — users,
nodes, hosts, config profiles, squads, subscriptions, node plugins, infra billing, system
stats — generated from the panel's own OpenAPI document rather than hand-written. Point a
newer spec at `npm run build-spec` and the tool surface follows.

## Highlights

- **Spec-driven, and self-updating.** `npm run update-spec` fetches the newest OpenAPI document
  from Remnawave's own published copy and rebuilds the catalogue; every tool's input schema
  comes straight from the operation's parameters and request body. Nothing about the API is
  written by hand, and the rebuild prints a diff naming every operation added, removed or
  renamed, so a version bump cannot silently drop a tool.
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
- **No requests that cannot succeed.** 16 endpoints (auth, passkeys, API-token management) are
  served only to a logged-in admin JWT and reject API tokens. They are detected from the spec
  and refused locally with an explanation instead of being sent.
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
| `REMNAWAVE_ALLOW_ADMIN_JWT_OPS`    | no       | `0`       | `1` allows the 16 admin-JWT-only endpoints (set only if your token is an admin JWT).         |

## Register with Claude Code

Read-only (recommended default):

```bash
claude mcp add remnawave --scope user \
  --env REMNAWAVE_BASE_URL=https://panel.example.com \
  --env REMNAWAVE_API_TOKEN_READ=your_read_token \
  -- npx -y @folexz/remnawave-mcp@latest
```

With mutations enabled and typed tools for the everyday controllers:

```bash
claude mcp add remnawave --scope user \
  --env REMNAWAVE_BASE_URL=https://panel.example.com \
  --env REMNAWAVE_API_TOKEN_READ=your_read_token \
  --env REMNAWAVE_API_TOKEN_WRITE=your_write_token \
  --env REMNAWAVE_TOOL_PROFILE=core \
  -- npx -y @folexz/remnawave-mcp@latest
```

`@latest` makes npx resolve the newest published version on each launch. To run a local build,
replace the command with `node /absolute/path/to/remnawave-mcp/dist/index.js`.

## Register with Claude Desktop / other MCP clients

```jsonc
{
  "mcpServers": {
    "remnawave": {
      "command": "npx",
      "args": ["-y", "@folexz/remnawave-mcp@latest"],
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
- **Sixteen endpoints are admin-JWT only** — the whole `auth` and `passkeys` controllers plus
  API-token management (`GET/POST /api/tokens`, `DELETE /api/tokens/{uuid}`,
  `GET /api/tokens/scopes`). The panel answers an API token with 401/403 there. This server
  detects them from the spec and refuses locally; `REMNAWAVE_ALLOW_ADMIN_JWT_OPS=1` lifts the
  gate if the token you configured really is an admin JWT.
- **`GET /api/users/stream` answers with newline-delimited JSON**, not one document. It is
  parsed into an array of user records rather than handed back as a blob of text.
- **`PATCH /api/hosts` *is* a real partial patch** — `{uuid, serverDescription}` alone works.
  Only config profiles have the replace-the-whole-thing semantics. Verified live.
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
npm test            # 50 unit tests + the offline smoke suite
npm run test:unit   # unit tests alone
```

The unit tests cover the parts that fail quietly: `$ref` expansion through Remnawave's
recursive DTOs, tool-name derivation (length budget, determinism, collision detection), the
catalogue diff, both write gates, the admin-JWT gate, schema collapsing and NDJSON parsing.

### Read-only checks against a real panel

With a panel reachable and a **read** token in the environment, the smoke script also runs live
read-only calls (never a mutation):

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

### Verifying the write path

Reads cannot prove that token routing, the throttle, the confirm gate and partial-patch
semantics actually work. `scripts/write-check.mjs` proves them on objects nobody is attached
to, and puts back the one pre-existing object it touches:

```bash
REMNAWAVE_BASE_URL=https://panel.example.com \
REMNAWAVE_API_TOKEN_READ="$T" REMNAWAVE_API_TOKEN_WRITE="$T" \
node scripts/write-check.mjs --i-understand-this-mutates [--host-uuid <uuid>]
```

It creates an internal squad with no inbounds and no members and deletes it again, then
rewrites `serverDescription` on one host and restores the original value. It refuses to start
without the acknowledgement flag, and reports a non-zero exit if anything is left behind.

Against a live 3.3.2 panel it confirmed: the confirm gate holds on a real `DELETE`; a partial
`PATCH /api/hosts` works; the panel rejects a 31-character `serverDescription`; the original
value (including `null`) round-trips; and consecutive mutations were spaced 1525 and 1524 ms
apart against a configured 1500 ms floor.

## Inspect locally

```bash
REMNAWAVE_BASE_URL=https://panel.example.com REMNAWAVE_API_TOKEN_READ=xxx npm run inspect
```

## Updating the API spec

Everything about the API comes from one file, so tracking a new Remnawave release is one
command:

```bash
npm run update-spec            # fetch the newest spec + rebuild the catalogue
npm run update-spec -- --strict  # additionally fail if any operation disappeared or was renamed
npm run build && npm test      # compile and verify
```

### Where the spec comes from

`https://cdn.remna.st/docs/openapi.json` — published by Remnawave's own
`Build&Push OpenAPI Specs` workflow on every upstream tag, so it always describes the newest
release. Override with `--url <u>` or `REMNAWAVE_SPEC_URL` to pin a different source.

A panel instance is **not** a usable source: docs are disabled unless the deployment turns them
on, and even then Swagger is mounted at `/backend-tools/swagger`, which the usual reverse proxy
does not route. Probing a live 3.3.2 panel returned 404 on every conventional spec path.

The download is only written to disk after it parses as an OpenAPI document with a non-empty
`paths`, so an error page or a captive portal cannot clobber a working spec.

### What to check afterwards

`build-spec` diffs the new catalogue against the previous one and prints every change:

```
build-spec: Remnawave API v3.4.0 -> 211 operations, 28 controllers, 315 KB
  methods: DELETE=22 GET=90 PATCH=19 POST=78 PUT=2  admin-JWT-only: 16
  diff: API version 3.3.2 -> 3.4.0
  REMOVED — tools that will disappear (1):
    remnawave_get_old_thing  (GET /api/old-thing)
  added (7):
    ...
```

- **REMOVED / RENAMED** are breaking for anyone whose prompts or scripts name those tools.
  `--strict` turns them into a non-zero exit, which is the flag automation should use.
- **added** is safe; the new operations are reachable through `remnawave_call` immediately and
  get typed tools if their controller is in the active profile.
- **schema changed** is worth a glance for the operations you actually use.

`npm test` then re-checks that the on-disk catalogue matches a fresh build, that all tool names
are unique and inside the 64-character budget, and that the guard rails still hold.

### Automating it

```bash
npm run update-spec -- --strict   # exits non-zero on a breaking catalogue change
npm test
npm version minor --no-git-tag-version
git commit -am "chore: Remnawave API 3.4.0" && git push
git tag "v$(node -p "require('./package.json').version")" && git push --tags
```

The pushed tag triggers the release workflow, which republishes to npm. Clients registered with
`@folexz/remnawave-mcp@latest` pick the new version up on their next launch.

## Releasing (maintainers)

### First publish — necessarily manual

npm cannot configure a trusted publisher for a package that does not exist yet: the setting
lives on the package's own settings page. That is a known, still-open limitation
([npm/cli#8544](https://github.com/npm/cli/issues/8544)), and it applies to scoped packages
too. So version 0.1.0 has to go up from a logged-in machine:

```bash
npm whoami            # must print the account that owns the @folexz scope
npm publish --access public
```

`--access public` is required: scoped packages default to restricted.

### Then switch to tokenless releases

Once the package exists, on npmjs.com → `@folexz/remnawave-mcp` → Settings → Trusted Publisher,
add a GitHub Actions publisher with repository `folexz/remnawave-mcp` and workflow
`release.yml`. `repository.url` in `package.json` must match the GitHub repository exactly — it
does.

After that, `.github/workflows/release.yml` publishes on any pushed `vX.Y.Z` tag via OIDC — no
token, no secret, with provenance attached automatically:

```bash
npm version patch --no-git-tag-version
git commit -am "chore: v0.1.1"
git push
git tag v0.1.1 && git push origin v0.1.1
```

The workflow reinstalls from the lockfile, rebuilds, runs the unit tests and the offline smoke
suite, and fails fast if the tag does not match `package.json`.

Clients registered with `@folexz/remnawave-mcp@latest` pick the new version up on their next
launch.

## Security notes

- Tokens are read from the environment only and are never logged. Logs go to stderr; stdout is
  the MCP JSON-RPC channel.
- Prefer configuring only `REMNAWAVE_API_TOKEN_READ`. Mutating tools do not exist without a
  write token, so a compromised or confused client cannot change the panel.
- Subscription endpoints return working client configs. Treat their output as secret.
- Never commit real tokens. `.env` is gitignored; `.env.example` shows the shape.

## Known limitations

- **Body validation is delegated to the panel.** This server checks only that required
  arguments and a required `body` are present; it does not validate the body's inner shape
  against the schema. That is deliberate — the panel already validates every field and answers
  with a precise `message` + `errorCode` (e.g. `A061`), and duplicating that locally would mean
  shipping a JSON Schema validator plus a second, inevitably drifting, copy of the rules. The
  cost is that a malformed body costs one round trip to find out.
- **The escape hatches bypass the per-operation gates.** `remnawave_request_write` is raw by
  design: it still requires a write token and still goes through the throttle and the retry
  logic, but it does not apply the destructive `confirm` gate or the admin-JWT check, because
  it has no operation to look those up from. Prefer `remnawave_call` unless you need a route
  the spec does not describe.
- **Tools are only as current as the shipped spec** (v3.3.2). A panel on a different minor
  version may expose routes it does not describe; that is what the escape hatches are for.
  See [Updating the API spec](#updating-the-api-spec).
- **Admin-JWT endpoints are gated, not implemented.** This server carries API tokens; it does
  not perform an admin login, hold a session, or refresh a JWT. If you supply an admin JWT as
  the token and set `REMNAWAVE_ALLOW_ADMIN_JWT_OPS=1`, those 16 endpoints become callable, but
  expiry and renewal are your problem.
- **The Prometheus basic-auth metrics endpoint** is not part of this spec and is not exposed.
- **`write-check.mjs` mutates.** It is a maintainer tool, excluded from `npm test`, and refuses
  to run without an explicit acknowledgement flag.

## License

MIT — see [LICENSE](./LICENSE).
