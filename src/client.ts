/**
 * RemnawaveClient — a thin fetch wrapper around a Remnawave panel.
 *
 * Responsibilities:
 *   1. Token selection by call mode: 'read' -> read token, 'write' -> write token.
 *      A write call with no write token configured fails loudly instead of silently
 *      falling back to the read token.
 *   2. Unwrapping the `{ "response": ... }` envelope every Remnawave endpoint uses, and
 *      turning `{ message, errorCode }` error bodies into readable errors.
 *   3. Retry with exponential backoff + jitter on transport failures, 429 and 5xx.
 *   4. Throttling mutations. This is not politeness: every write that touches a config
 *      profile makes the panel push the new config to all nodes and restart Xray on each,
 *      and a burst of PATCHes will take the panel's own TLS listener down for a while.
 *      Mutations are therefore serialised with a minimum gap between them.
 *
 * Note on reachability: the panel is only reliably reachable over its public HTTPS origin.
 * Pointing REMNAWAVE_BASE_URL at http://127.0.0.1:3000 from the panel host itself does not
 * work even though docker-proxy is listening there — use the real hostname.
 */
import type { Config } from "./config.js";

export type Mode = "read" | "write";

export interface RequestOptions {
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  mode: Mode;
}

export class RemnawaveError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = "RemnawaveError";
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 524]);

export class RemnawaveClient {
  /** Serialises mutations: each write waits for the previous one plus the configured gap. */
  private writeChain: Promise<void> = Promise.resolve();
  private lastWriteAt = 0;

  constructor(private readonly config: Config) {}

  private tokenFor(mode: Mode): string {
    if (mode === "read") return this.config.readToken;
    if (!this.config.writeToken) {
      throw new RemnawaveError(
        "This operation mutates the panel, but REMNAWAVE_API_TOKEN_WRITE is not configured. " +
          "The server is running read-only."
      );
    }
    return this.config.writeToken;
  }

  async request(method: string, path: string, opts: RequestOptions): Promise<unknown> {
    if (opts.mode !== "write") return this.execute(method, path, opts);

    // Queue behind any in-flight mutation, then honour the minimum interval.
    const run = this.writeChain.then(async () => {
      const wait = this.config.writeMinIntervalMs - (Date.now() - this.lastWriteAt);
      if (wait > 0) await sleep(wait);
    });
    this.writeChain = run.catch(() => undefined);
    await run;
    try {
      return await this.execute(method, path, opts);
    } finally {
      this.lastWriteAt = Date.now();
    }
  }

  private async execute(method: string, path: string, opts: RequestOptions): Promise<unknown> {
    const url = new URL(this.config.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }

    const token = this.tokenFor(opts.mode);
    const upperMethod = method.toUpperCase();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "user-agent": "remnawave-mcp",
    };
    const hasBody = opts.body !== undefined && opts.body !== null && upperMethod !== "GET";
    if (hasBody) headers["content-type"] = "application/json";

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt));
      try {
        const res = await fetch(url, {
          method: upperMethod,
          headers,
          body: hasBody ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });

        if (RETRYABLE_STATUS.has(res.status) && attempt < this.config.maxRetries) {
          lastError = new RemnawaveError(
            `HTTP ${res.status} ${res.statusText}`,
            undefined,
            res.status
          );
          continue;
        }
        return await parseResponse(res);
      } catch (err) {
        // Transport-level failure: DNS, connection reset, TLS handshake, timeout. The panel
        // does drop TLS while it is restarting Xray on the nodes, so these are worth retrying.
        if (err instanceof RemnawaveError) throw err;
        lastError = err;
        if (attempt >= this.config.maxRetries) break;
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new RemnawaveError(
      `Request failed after ${this.config.maxRetries + 1} attempt(s): ${message} ` +
        `(${upperMethod} ${url.pathname})`
    );
  }
}

async function parseResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    if (!res.ok) {
      throw new RemnawaveError(truncate(text) || res.statusText, undefined, res.status);
    }
    return text;
  }

  if (!res.ok) {
    const message = parsed?.message ?? parsed?.error ?? res.statusText;
    const code = parsed?.errorCode;
    throw new RemnawaveError(
      `${typeof message === "string" ? message : JSON.stringify(message)}` +
        (code ? ` [${code}]` : "") +
        ` (HTTP ${res.status})`,
      code,
      res.status
    );
  }

  // Every Remnawave endpoint wraps its payload in { "response": ... }.
  return parsed && typeof parsed === "object" && "response" in parsed ? parsed.response : parsed;
}

function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
