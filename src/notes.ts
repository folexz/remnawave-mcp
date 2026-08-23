/**
 * Field notes — behaviour of a live Remnawave panel that the OpenAPI document does not say.
 *
 * Every entry below was hit against a production 3.3.2 panel. They are attached to the
 * matching operation's description (so they show up in `tools/list`) and repeated in full by
 * `remnawave_describe_operation`, which is where a model looks right before composing a body.
 *
 * Keys are `METHOD /path` (exactly as they appear in the spec) or a `controller:<slug>` form
 * that applies to every operation of that controller.
 */

export const GENERAL_NOTES: string[] = [
  "Every response is wrapped in {\"response\": ...}; this server unwraps it, so tool output is the payload itself.",
  "The panel is only reachable over its public HTTPS origin with a Bearer token. Even on the panel host, http://127.0.0.1:3000 does not answer although docker-proxy listens there — always use the real hostname.",
  "Errors come back as {message, errorCode} with codes like A061; the errorCode is included in this server's error text.",
  "Writes that touch config profiles, hosts or nodes make the panel push config to every node and restart Xray there. Several such calls back to back can take the panel's TLS listener down for a minute. This server serialises mutations with a minimum interval (REMNAWAVE_WRITE_MIN_INTERVAL_MS, default 1500 ms) and retries transport failures with backoff — do not defeat it by firing bulk updates in parallel.",
];

export const OPERATION_NOTES: Record<string, string[]> = {
  "patch /api/config-profiles": [
    "The body is {uuid, config} and `config` must be the COMPLETE, valid Xray config — this is a replace, not a partial patch. Sending a fragment fails with A061 \"Config doesn't have inbounds\".",
    "Correct sequence: GET /api/config-profiles/{uuid} -> take `config` -> edit the object in place -> PATCH the whole thing back with the same uuid.",
  ],
  "post /api/config-profiles": [
    "Body is {name, config}; `config` must already be a full valid Xray config with at least one inbound (A061 otherwise).",
  ],
  "get /api/config-profiles/{uuid}": [
    "Returns the full profile including `config` — this is the correct starting point for any edit, because PATCH replaces the config wholesale.",
  ],
  "post /api/hosts": [
    "A host binds to an inbound through the NESTED field `inbound.configProfileUuid` (plus `inbound.configProfileInboundUuid`), NOT a top-level configProfileUuid. Putting it at the top level is silently wrong.",
    "`serverDescription` is limited to 30 characters.",
  ],
  "patch /api/hosts": [
    "Body must include `uuid`. The profile binding lives in the NESTED `inbound.configProfileUuid` / `inbound.configProfileInboundUuid`, not at the top level.",
    "`serverDescription` is limited to 30 characters.",
    "Hysteria2 hosts render as raw JSON in Happ unless `serverDescription` is set on the host (meta.serverDescription is not enough).",
  ],
  "patch /api/hosts/bulk/update": [
    "Applies the same partial patch to many hosts at once and triggers one config push per affected node. Treat as destructive: it needs confirm=true unless REMNAWAVE_SKIP_CONFIRM is set.",
  ],
  "post /api/subscription-templates": [
    "Creates an EMPTY template only — the request body carries the type/name, not the content. Upload the actual template body with a follow-up PATCH /api/subscription-templates.",
  ],
  "patch /api/subscription-templates": [
    "This is where the template content goes. JSON and YAML bodies cannot be updated in the same call (A174), and a JSON body is rejected for a YAML template (A172/A173).",
  ],
  "get /api/users": [
    "Paginated: `start` (offset) and `size` (page length). Filters use the `filters[0][id]` / `filters[0][value]` query style — if you need something exotic, remnawave_request_read passes arbitrary query keys through untouched.",
  ],
  "get /api/users/stream": [
    "Streams every user as newline-delimited JSON. It can be very large on a real panel; prefer GET /api/users with paging unless you truly need everything.",
  ],
  "post /api/users/bulk/delete-by-status": [
    "Deletes every user in the given status in one shot and cannot be undone.",
  ],
  "delete /api/hwid/devices/delete-all": [
    "Wipes all HWID devices for the user; they will need to re-register their devices.",
  ],
  "post /api/nodes/actions/restart-all": [
    "Restarts Xray on every node simultaneously — all clients drop. Prefer per-node POST /api/nodes/{uuid}/actions/restart.",
  ],
  "post /api/node-plugins/torrent-blocker/truncate": [
    "Clears the entire torrent-blocker history table.",
  ],
  "get /api/system/health": [
    "Cheap liveness probe — good first call to verify the base URL and token are right.",
  ],
};

export const CONTROLLER_NOTES: Record<string, string[]> = {
  auth: [
    "These endpoints mint/inspect admin sessions, not API tokens. An API token cannot call most of them; they are listed for completeness.",
  ],
  "public-subscription": [
    "Unauthenticated subscription delivery endpoints. They are keyed by shortUuid and return client configs — treat their output as secret.",
  ],
  passkeys: ["Admin-JWT only; an API token is rejected."],
};

export function notesFor(method: string, path: string, controllerSlug: string): string[] {
  return [
    ...(OPERATION_NOTES[`${method.toLowerCase()} ${path}`] ?? []),
    ...(CONTROLLER_NOTES[controllerSlug] ?? []),
  ];
}
