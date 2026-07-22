import { readFile } from "node:fs/promises";
import { z } from "zod";
import * as sdk from "./http-client";

/**
 * The `autonoma-planner sdk <action>` command group - the interactive coding
 * agent's endpoint client. The agent shells out to it to exercise its own
 * integration: `discover`, `up` (returns a refsToken), and `down` (takes that
 * token). The CLI owns request signing (HMAC over the raw body with the canonical
 * AUTONOMA_SHARED_SECRET from the env) and the request shape, so the agent
 * validates against the exact client the platform's test runner uses instead of
 * hand-rolling signatures.
 *
 * Output contract (so the agent can parse it): a single JSON object
 * `{ ok, status, body }` on stdout, and an exit code - 0 on a 2xx, 1 on a non-2xx
 * or request error, 2 on a usage error (missing secret/url/args).
 */

/**
 * Per-request abort so a hung handler can't stall the agent's shell forever.
 * A cold full-recipe `up` (first compile + many sequential real-service inserts)
 * can be slow, so the default is generous and `--timeout <seconds>` raises it.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export interface SdkCommandIo {
    env: NodeJS.ProcessEnv;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
}

const createSchema = z.record(z.string(), z.array(z.unknown()));
const envelopeSchema = z.object({ recipes: z.array(z.object({ create: createSchema })).min(1) });
const bareCreateWrapperSchema = z.object({ create: createSchema });

/**
 * The flags any `sdk` subcommand accepts. `.strict()` so a typo'd flag is a hard
 * error instead of being silently dropped; `timeout` is coerced from its string
 * token and validated as positive seconds. Which flags are *required* is
 * action-specific and checked below.
 */
const flagsSchema = z
    .object({
        url: z.string().min(1).optional(),
        recipe: z.string().min(1).optional(),
        "refs-token": z.string().min(1).optional(),
        "test-run-id": z.string().min(1).optional(),
        timeout: z.coerce.number().int().positive().optional(),
    })
    .strict();

/** Run one `sdk` subcommand. `argv` is everything after `sdk` (e.g. `["up", "--url", ...]`). */
export async function runSdkCommand(argv: string[], io: SdkCommandIo): Promise<number> {
    const action = argv[0];

    const sharedSecret = io.env.AUTONOMA_SHARED_SECRET;
    if (sharedSecret == null || sharedSecret === "") {
        io.stderr("AUTONOMA_SHARED_SECRET is not set in the environment.\n");
        return 2;
    }

    const parsedFlags = flagsSchema.safeParse(tokenizeFlags(argv.slice(1)));
    if (!parsedFlags.success) {
        io.stderr(`Invalid flags: ${formatIssues(parsedFlags.error)}\n`);
        return 2;
    }
    const flags = parsedFlags.data;

    if (flags.url == null) {
        io.stderr("--url <endpoint-url> is required.\n");
        return 2;
    }

    const timeoutMs = flags.timeout != null ? flags.timeout * 1000 : DEFAULT_REQUEST_TIMEOUT_MS;
    const config: sdk.SdkClientConfig = { endpointUrl: flags.url, sharedSecret, timeoutMs };

    try {
        if (action === "discover") return emit(io, await sdk.discover(config));

        if (action === "up") {
            if (flags.recipe == null) {
                io.stderr("--recipe <file> is required for `up`.\n");
                return 2;
            }
            const create = await loadCreatePayload(flags.recipe);
            return emit(io, await sdk.up(config, create, flags["test-run-id"] ?? `cli-${Date.now()}`));
        }

        if (action === "down") {
            if (flags["refs-token"] == null) {
                io.stderr("--refs-token <token> is required for `down` (use the refsToken returned by `up`).\n");
                return 2;
            }
            return emit(io, await sdk.down(config, flags["refs-token"]));
        }

        io.stderr(`Unknown sdk action "${action ?? ""}". Use one of: discover | up | down.\n`);
        return 2;
    } catch (err) {
        // AbortSignal.timeout rejects with a TimeoutError/AbortError - name it explicitly
        // rather than surfacing the opaque "operation was aborted".
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        const detail = err instanceof Error ? err.message : String(err);
        const suffix = timedOut ? ` (request timed out after ${timeoutMs / 1000}s; raise --timeout)` : "";
        io.stderr(`sdk ${action ?? ""} failed${suffix}: ${detail}\n`);
        return 1;
    }
}

/** Emit the response as JSON and map HTTP success to the process exit code. */
function emit(io: SdkCommandIo, res: sdk.SdkResponse): number {
    io.stdout(JSON.stringify({ ok: res.ok, status: res.status, body: res.body }, null, 2) + "\n");
    return res.ok ? 0 : 1;
}

/**
 * Read the `create` payload (entity -> records) from a recipe file. Accepts a full
 * recipe envelope (`{ recipes: [{ create }] }`), a `{ create }` wrapper, or a bare
 * `create` map - so the agent can point at the whole recipe.json or a single-entity
 * slice it wrote. Validated with zod (no casts) at this file boundary.
 */
async function loadCreatePayload(file: string): Promise<Record<string, unknown[]>> {
    const raw = await readFile(file, "utf-8");

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (err) {
        throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    const envelope = envelopeSchema.safeParse(json);
    if (envelope.success) return envelope.data.recipes[0]!.create;

    const wrapped = bareCreateWrapperSchema.safeParse(json);
    if (wrapped.success) return wrapped.data.create;

    const bare = createSchema.safeParse(json);
    if (bare.success) return bare.data;

    throw new Error(
        `${file} is not a valid recipe: expected a full recipe envelope, a { create } object, or a bare { Entity: [records] } map.`,
    );
}

/** Tokenize `--key value`, `--key=value`, and bare `--flag` (-> "true") into a map. */
function tokenizeFlags(argv: string[]): Record<string, string> {
    const flags: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (!arg.startsWith("--")) continue;
        const body = arg.slice(2);
        const eq = body.indexOf("=");
        if (eq !== -1) {
            flags[body.slice(0, eq)] = body.slice(eq + 1);
            continue;
        }
        const next = argv[i + 1];
        if (next != null && !next.startsWith("--")) {
            flags[body] = next;
            i++;
        } else {
            flags[body] = "true";
        }
    }
    return flags;
}

/** Render zod flag issues as `--flag: message` (the `--` so the fix is obvious). */
function formatIssues(error: z.ZodError): string {
    return error.issues.map((i) => (i.path.length > 0 ? `--${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}
