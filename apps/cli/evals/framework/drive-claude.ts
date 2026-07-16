import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Drive the `claude -p` subinstance (the developer surrogate) over the sandbox on
 * Bedrock. Captures the full stream-json transcript and a distilled progress log,
 * enforces a wall-clock cap, and never inherits the operator's AWS/Anthropic env
 * beyond what we set explicitly.
 *
 * NOTE: the host command that runs this MUST have any network sandbox DISABLED -
 * the Bedrock presigned bearer token 403s through a proxy otherwise.
 */

export interface DriveOpts {
    /** The sandbox the subinstance edits - never the cache/golden. Its git diff is the answer. */
    sandbox: string;
    /**
     * Extra dirs the subinstance may read (added as `--add-dir`) - the staged
     * frozen artifacts. Kept OUTSIDE the sandbox so reading/updating them never
     * shows up in the sandbox's git diff.
     */
    readableDirs?: string[];
    /** Private HOME so the subinstance's ~/.claude is scoped to the run. */
    runHome: string;
    prompt: string;
    model: string;
    bedrockToken: string;
    region: string;
    /**
     * Env the app inherits when the subinstance boots it - notably
     * AUTONOMA_SHARED_SECRET, which its endpoint must verify signatures against.
     */
    appEnv?: Record<string, string>;
    runDir: string;
    /** Wall-clock cap in ms; <= 0 means run until the subinstance exits. */
    timeoutMs: number;
}

export interface DriveResult {
    exitCode: number | undefined;
    timedOut: boolean;
    streamPath: string;
    progressPath: string;
    durationMs: number;
}

const GRACEFUL_KILL_MS = 10_000;
const MAX_TEXT_LEN = 240;
const MAX_INPUT_LEN = 120;

const contentPartSchema = z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("tool_use"), name: z.string(), input: z.record(z.string(), z.unknown()).optional() }),
    z.object({ type: z.string() }),
]);
const streamEventSchema = z.union([
    z.object({ type: z.literal("assistant"), message: z.object({ content: z.array(contentPartSchema) }) }),
    z.object({
        type: z.literal("result"),
        subtype: z.string().optional(),
        num_turns: z.number().optional(),
        total_cost_usd: z.number().optional(),
    }),
    z.object({ type: z.string() }),
]);

/** Distill a one-line human signal from a stream-json event, if any. */
function distill(raw: unknown): string | undefined {
    const evt = streamEventSchema.safeParse(raw);
    if (!evt.success) return undefined;
    const data = evt.data;

    if (data.type === "assistant" && "message" in data) {
        const parts = data.message.content;
        const text = parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join(" ")
            .trim();
        if (text) return `· ${text.replace(/\s+/g, " ").slice(0, MAX_TEXT_LEN)}`;

        const tools = parts.filter(
            (p): p is { type: "tool_use"; name: string; input?: Record<string, unknown> } => p.type === "tool_use",
        );
        if (tools.length) return tools.map((t) => `  ↳ ${t.name}(${summarizeInput(t.name, t.input)})`).join("\n");
    }

    if (data.type === "result" && "subtype" in data) {
        return `▮ result: ${data.subtype ?? ""} (${data.num_turns ?? "?"} turns, $${data.total_cost_usd ?? "?"})`;
    }
    return undefined;
}

function summarizeInput(name: string, input?: Record<string, unknown>): string {
    if (input == null) return "";
    if (name === "Bash") return String(input.command ?? "").slice(0, MAX_INPUT_LEN);
    if (name === "Edit" || name === "Write" || name === "Read")
        return String(input.file_path ?? "").slice(0, MAX_INPUT_LEN);
    const s = JSON.stringify(input);
    return s.length > MAX_INPUT_LEN ? s.slice(0, MAX_INPUT_LEN) + "…" : s;
}

export async function driveClaude(opts: DriveOpts): Promise<DriveResult> {
    mkdirSync(opts.runDir, { recursive: true });
    const streamPath = join(opts.runDir, "claude.stream.jsonl");
    const progressPath = join(opts.runDir, "progress.log");
    const stream = createWriteStream(streamPath);
    const progress = createWriteStream(progressPath);

    const addDirs = [opts.sandbox, ...(opts.readableDirs ?? [])].flatMap((d) => ["--add-dir", d]);
    const args = [
        "-p",
        opts.prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        ...addDirs,
        "--model",
        opts.model,
    ];

    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: opts.runHome,
        LANG: process.env.LANG ?? "en_US.UTF-8",
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_BEARER_TOKEN_BEDROCK: opts.bedrockToken,
        AWS_REGION: opts.region,
        ANTHROPIC_MODEL: opts.model,
        CLAUDE_CODE_SUBAGENT_MODEL: opts.model,
        ...opts.appEnv,
    };

    const start = Date.now();
    const child = spawn("claude", args, {
        cwd: opts.sandbox,
        env,
        detached: true, // own process group so we can kill the whole tree on timeout
        stdio: ["ignore", "pipe", "pipe"],
    });

    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
        stream.write(chunk);
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                continue; // non-JSON line; already kept raw in the stream file
            }
            const note = distill(parsed);
            if (note != null) {
                progress.write(note + "\n");
                process.stdout.write(note + "\n");
            }
        }
    });
    child.stderr.on("data", (chunk: Buffer) => stream.write(chunk));

    let timedOut = false;
    const timer =
        opts.timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true;
                  killTree(child.pid, "SIGTERM");
                  setTimeout(() => killTree(child.pid, "SIGKILL"), GRACEFUL_KILL_MS);
              }, opts.timeoutMs)
            : undefined;

    const exitCode = await new Promise<number | undefined>((resolve) => {
        child.on("close", (code) => resolve(code ?? undefined));
    });

    if (timer != null) clearTimeout(timer);
    stream.end();
    progress.end();

    return { exitCode, timedOut, streamPath, progressPath, durationMs: Date.now() - start };
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
    if (pid == null) return;
    try {
        process.kill(-pid, signal);
    } catch (err) {
        console.error(`[drive] failed to ${signal} process group ${pid}`, err);
    }
}
