import { readFile } from "node:fs/promises";
import { isRecord, ScenarioRecipeVariablesSchema, type ScenarioVariableScalar } from "@autonoma/types";
import { resolveRecipeCreateGraph } from "@autonoma/types/scenario-recipe-resolver";
import { z } from "zod";
import { CliArgs } from "../../core/cli-args";
import * as sdk from "./http-client";
import { findRecipeUploadProblems, loadRecipeFile } from "./recipe";

/**
 * The `autonoma-planner sdk <action>` command group - the interactive coding
 * agent's endpoint client. The agent shells out to it to exercise its own
 * integration: `discover`, `up` (returns a refsToken), `down` (takes that token),
 * and `check` (holds the recipe file itself to the format Autonoma accepts). The
 * CLI owns request signing (HMAC over the raw body with the canonical
 * AUTONOMA_SHARED_SECRET from the env), recipe-token resolution, and the request
 * shape, so the agent validates against the exact payload the platform's test
 * runner sends instead of hand-rolling either.
 *
 * Output contract (so the agent can parse it): a single JSON object
 * `{ ok, status, body }` on stdout - `up` adds `testRunId` and the
 * `resolvedVariables` it substituted, so the agent knows which values to look for
 * in the database - and an exit code: 0 on a 2xx, 1 on a non-2xx or request error,
 * 2 on a usage error (missing secret/url/args). Two actions answer a different
 * question and emit their own shape: `check` talks to nothing and emits
 * `{ ok, recipe, problems, recipes }`, and `up --repeat <n>` seeds n concurrent
 * instances and emits `{ ok, instances, teardown, hint }`.
 */

/**
 * Per-request abort so a hung handler can't stall the agent's shell forever.
 * A cold full-recipe `up` (first compile + many sequential real-service inserts)
 * can be slow, so the default is generous and `--timeout <seconds>` raises it.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** `--repeat 1` is just an `up`, so the flag only means anything from two instances up. */
const MIN_REPEAT_INSTANCES = 2;

export interface SdkCommandIo {
    env: NodeJS.ProcessEnv;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
}

const createSchema = z.record(z.string(), z.array(z.unknown()));
const recipeSliceSchema = z.object({ create: createSchema, variables: ScenarioRecipeVariablesSchema.optional() });
const envelopeSchema = z.object({ recipes: z.array(recipeSliceSchema).min(1) });

/** A recipe's unresolved entity graph plus the variable block that names its non-built-in tokens. */
type RecipeSlice = z.infer<typeof recipeSliceSchema>;

/**
 * The flags any `sdk` subcommand accepts. `timeout` and `repeat` are coerced from
 * their string tokens and validated as counts. Which flags are *required* is
 * action-specific and checked below.
 */
const flagsSchema = z.object({
    url: z.string().min(1).optional(),
    recipe: z.string().min(1).optional(),
    "refs-token": z.string().min(1).optional(),
    "test-run-id": z.string().min(1).optional(),
    timeout: z.coerce.number().int().positive().optional(),
    repeat: z.coerce.number().int().min(MIN_REPEAT_INSTANCES).optional(),
});

/** The spellings this command answers to, derived from the schema so the two cannot drift. */
const SDK_FLAGS: ReadonlySet<string> = new Set(Object.keys(flagsSchema.shape));

/** Run one `sdk` subcommand. `argv` is everything after `sdk` (e.g. `["up", "--url", ...]`). */
export async function runSdkCommand(argv: string[], io: SdkCommandIo): Promise<number> {
    const action = argv[0];
    const args = CliArgs.parse(argv.slice(1));

    // A typo'd flag is a hard error, not a silently dropped one: the caller here is an
    // agent working from a copied command, and a dropped --recipe would read as "you
    // never passed one" rather than "you spelled it wrong".
    const unknown = args.unrecognized(SDK_FLAGS);
    if (unknown.length > 0) {
        io.stderr(`Unknown flag(s): ${unknown.map(describeUnknownFlag).join("; ")}\n`);
        return 2;
    }

    // `check` reads a local file and talks to nothing, so it runs before the
    // secret/url guards the request actions need.
    if (action === "check") {
        const recipe = args.value("recipe");
        if (recipe == null || recipe === "") {
            io.stderr("--recipe <file> is required for `check`.\n");
            return 2;
        }
        return await runCheck(recipe, io);
    }

    const sharedSecret = io.env.AUTONOMA_SHARED_SECRET;
    if (sharedSecret == null || sharedSecret === "") {
        io.stderr("AUTONOMA_SHARED_SECRET is not set in the environment.\n");
        return 2;
    }

    const parsedFlags = flagsSchema.safeParse({
        url: args.value("url"),
        recipe: args.value("recipe"),
        "refs-token": args.value("refs-token"),
        "test-run-id": args.value("test-run-id"),
        timeout: args.value("timeout"),
        repeat: args.value("repeat"),
    });
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
            const baseRunId = flags["test-run-id"] ?? `cli-${Date.now()}`;
            const slice = await loadRecipeSlice(flags.recipe);

            if (flags.repeat != null) return await runRepeatedUps(config, slice, baseRunId, flags.repeat, io);

            const resolution = resolveRecipeCreateGraph({
                create: slice.create,
                variables: slice.variables,
                testRunId: baseRunId,
            });
            // Substitution walks the graph as plain JSON, so re-parse to recover the entity -> records shape.
            const create = createSchema.parse(resolution.createPayload);
            return emit(io, await sdk.up(config, create, baseRunId), {
                testRunId: baseRunId,
                resolvedVariables: resolution.resolvedVariables,
            });
        }

        if (action === "down") {
            if (flags["refs-token"] == null) {
                io.stderr("--refs-token <token> is required for `down` (use the refsToken returned by `up`).\n");
                return 2;
            }
            return emit(io, await sdk.down(config, flags["refs-token"]));
        }

        io.stderr(`Unknown sdk action "${action ?? ""}". Use one of: discover | up | down | check.\n`);
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

/** One instance of the recipe seeded during a `--repeat` run. */
interface UpInstance {
    instance: number;
    testRunId: string;
    ok: boolean;
    status: number;
    /** Present when the seed succeeded - what `down` needs to remove this instance again. */
    refsToken?: string;
    /** Only the failing instance carries its body; N full seed responses would drown the output. */
    body?: unknown;
}

/**
 * Seed the SAME recipe N times over, each with its own testRunId and WITHOUT tearing down in
 * between, so every instance is live at once. This is the only check that catches a recipe
 * whose unique columns hold hardcoded values: every other check tears down before the next
 * seed, so a recipe that can only ever exist once passes all of them - and then breaks the
 * first time a customer runs two tests at the same time. The second seed collides with the
 * first, and the endpoint's error names the exact constraint.
 *
 * It stops at the first failure (a third seed would only repeat it and bury more rows), then
 * tears down every instance it brought up, newest first. Cleanup is not optional: rows left
 * behind would collide with the NEXT run of this command and read as a defect in whatever the
 * author changed in between.
 */
async function runRepeatedUps(
    config: sdk.SdkClientConfig,
    slice: RecipeSlice,
    baseRunId: string,
    instances: number,
    io: SdkCommandIo,
): Promise<number> {
    const seeded: UpInstance[] = [];

    for (let index = 1; index <= instances; index++) {
        const testRunId = `${baseRunId}-${index}`;
        const resolution = resolveRecipeCreateGraph({
            create: slice.create,
            variables: slice.variables,
            testRunId,
        });
        const create = createSchema.parse(resolution.createPayload);
        const res = await sdk.up(config, create, testRunId);
        const refsToken = readRefsToken(res.body);

        seeded.push({
            instance: index,
            testRunId,
            ok: res.ok,
            status: res.status,
            refsToken,
            body: res.ok ? undefined : res.body,
        });
        if (!res.ok) break;
    }

    const failed = seeded.find((instance) => !instance.ok);
    const teardown = await tearDownInstances(config, seeded);

    io.stdout(
        JSON.stringify(
            {
                ok: failed == null,
                action: "up",
                repeat: instances,
                instances: seeded,
                teardown,
                hint: repeatHint(failed, instances, teardown),
            },
            null,
            2,
        ) + "\n",
    );

    return failed == null && teardown.every((result) => result.ok) ? 0 : 1;
}

/** What became of each instance's teardown, newest first - reported so a leak is never silent. */
interface TeardownResult {
    testRunId: string;
    ok: boolean;
    detail?: string;
}

/**
 * Remove every instance that was seeded, newest first. A instance whose `up` failed may still
 * have written rows before it hit the constraint, but it has no refsToken to remove them with,
 * so it is reported rather than silently skipped.
 */
async function tearDownInstances(config: sdk.SdkClientConfig, seeded: UpInstance[]): Promise<TeardownResult[]> {
    const results: TeardownResult[] = [];

    for (const instance of [...seeded].reverse()) {
        if (instance.refsToken == null) {
            results.push({
                testRunId: instance.testRunId,
                ok: false,
                detail: "no refsToken in the up response - anything it wrote before failing is still there",
            });
            continue;
        }
        try {
            const res = await sdk.down(config, instance.refsToken);
            results.push({
                testRunId: instance.testRunId,
                ok: res.ok,
                detail: res.ok ? undefined : `down returned HTTP ${res.status}`,
            });
        } catch (err) {
            results.push({
                testRunId: instance.testRunId,
                ok: false,
                detail: `down failed: ${err instanceof Error ? err.message : String(err)}`,
            });
        }
    }

    return results;
}

/** One line telling the reader what the run proved, and what to do about it. */
function repeatHint(failed: UpInstance | undefined, instances: number, teardown: TeardownResult[]): string {
    const leaked = teardown.filter((result) => !result.ok).map((result) => result.testRunId);
    const leakNote =
        leaked.length > 0 ? ` Teardown did NOT complete for ${leaked.join(", ")} - check the database by hand.` : "";

    if (failed == null) {
        return `All ${instances} instances were live at the same time, so nothing in this recipe is single-instance.${leakNote}`;
    }
    return (
        `Instance ${failed.instance} failed to seed while instance ${failed.instance - 1} was still up (HTTP ${failed.status}). ` +
        `That is a value this recipe reuses across runs: read the error above for the constraint it violated, then put ` +
        `{{testRunId}} or {{testRunShortId}} inside that field - or derive it from the testRunId your factory receives. ` +
        `Do not weaken the constraint.${leakNote}`
    );
}

/** The handle `down` needs, as the SDK returns it on a successful `up`. */
function readRefsToken(body: unknown): string | undefined {
    if (!isRecord(body)) return undefined;
    return typeof body.refsToken === "string" ? body.refsToken : undefined;
}

/**
 * Hold a recipe file to the exact gate the planner applies when it takes the terminal back:
 * the upload schema, then the `create`-graph checks Autonoma runs on ingest. This is the
 * agent's own way to know its recipe is submittable BEFORE it declares the session done -
 * without it, a malformed recipe only surfaces after the agent has exited, and fixing it
 * costs a whole re-launch. Emits every problem at once so one pass fixes all of them.
 */
async function runCheck(recipePath: string, io: SdkCommandIo): Promise<number> {
    const read = await loadRecipeFile(recipePath);

    if (read.status === "absent") {
        io.stdout(
            JSON.stringify(
                { ok: false, recipe: recipePath, problems: [`${recipePath} does not exist - write it first.`] },
                null,
                2,
            ) + "\n",
        );
        return 1;
    }

    if (read.status === "invalid") {
        io.stdout(JSON.stringify({ ok: false, recipe: recipePath, problems: read.problems }, null, 2) + "\n");
        return 1;
    }

    const problems = findRecipeUploadProblems(read.recipe);
    const summary = read.recipe.recipes.map((entry) => ({
        name: entry.name,
        entities: Object.keys(entry.create).length,
        records: Object.values(entry.create).reduce<number>(
            (total, rows) => total + (Array.isArray(rows) ? rows.length : 0),
            0,
        ),
    }));

    io.stdout(
        JSON.stringify({ ok: problems.length === 0, recipe: recipePath, problems, recipes: summary }, null, 2) + "\n",
    );
    return problems.length === 0 ? 0 : 1;
}

/** What `up` substituted into the recipe, so the agent can predict the rows the seed produced. */
interface EmittedResolution {
    testRunId: string;
    resolvedVariables: Record<string, ScenarioVariableScalar>;
}

/** Emit the response as JSON and map HTTP success to the process exit code. */
function emit(io: SdkCommandIo, res: sdk.SdkResponse, resolution?: EmittedResolution): number {
    const output =
        resolution == null
            ? { ok: res.ok, status: res.status, body: res.body }
            : {
                  ok: res.ok,
                  status: res.status,
                  body: res.body,
                  testRunId: resolution.testRunId,
                  resolvedVariables: resolution.resolvedVariables,
              };
    io.stdout(JSON.stringify(output, null, 2) + "\n");
    return res.ok ? 0 : 1;
}

/**
 * Read a recipe's `create` graph (entity -> records) and its `variables` block from
 * a recipe file. Accepts a full recipe envelope (`{ recipes: [{ create }] }`), a
 * `{ create }` wrapper, or a bare `create` map - so the agent can point at the whole
 * recipe.json or a single-entity slice it wrote. Validated with zod (no casts) at
 * this file boundary.
 */
async function loadRecipeSlice(file: string): Promise<RecipeSlice> {
    const raw = await readFile(file, "utf-8");

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (err) {
        throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    const envelope = envelopeSchema.safeParse(json);
    if (envelope.success) return envelope.data.recipes[0]!;

    const wrapped = recipeSliceSchema.safeParse(json);
    if (wrapped.success) return wrapped.data;

    const bare = createSchema.safeParse(json);
    if (bare.success) return { create: bare.data };

    throw new Error(
        `${file} is not a valid recipe: expected a full recipe envelope, a { create } object, or a bare { Entity: [records] } map.`,
    );
}

/** `--recipie (did you mean --recipe?)` - the suggestion is the whole value of the message. */
function describeUnknownFlag(unknown: { given: string; meant?: string }): string {
    return unknown.meant != null ? `--${unknown.given} (did you mean --${unknown.meant}?)` : `--${unknown.given}`;
}

/** Render zod flag issues as `--flag: message` (the `--` so the fix is obvious). */
function formatIssues(error: z.ZodError): string {
    return error.issues.map((i) => (i.path.length > 0 ? `--${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}
