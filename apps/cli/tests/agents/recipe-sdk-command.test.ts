import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSdkCommand, type SdkCommandIo } from "../../src/agents/04-recipe-builder/sdk-command";

const SECRET = "sdk-cmd-secret";

/** The `up` request body the emulator last received, so a test can assert what was actually sent. */
interface UpRequest {
    testRunId?: string;
    create?: Record<string, Array<Record<string, unknown>>>;
}

/** A signed-endpoint emulator: verifies x-signature against SECRET, then answers
 *  per action (up returns a refsToken). Mirrors the SDK handler's wire contract. */
function startEmulator(): Promise<{ server: Server; url: string; lastUp: () => UpRequest | undefined }> {
    let lastUp: UpRequest | undefined;
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            const sigOk = req.headers["x-signature"] === createHmac("sha256", SECRET).update(raw).digest("hex");
            if (!sigOk) return void res.writeHead(401).end(JSON.stringify({ error: "bad signature" }));
            const parsed: { action?: unknown } & UpRequest = JSON.parse(raw);
            const action = String(parsed.action ?? "");
            if (action === "up") lastUp = { testRunId: parsed.testRunId, create: parsed.create };
            const body =
                action === "up"
                    ? { refsToken: "tok-123", auth: { headers: { Authorization: "Bearer real" } } }
                    : action === "discover"
                      ? { schema: { models: [] }, scenarios: ["standard"] }
                      : { ok: true };
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            const port = typeof addr === "object" && addr != null ? addr.port : 0;
            resolve({ server, url: `http://127.0.0.1:${port}/api/autonoma`, lastUp: () => lastUp });
        });
    });
}

function captureIo(env: NodeJS.ProcessEnv): SdkCommandIo & { out: string; err: string } {
    const io = {
        out: "",
        err: "",
        env,
        stdout: (t: string) => {
            io.out += t;
        },
        stderr: (t: string) => {
            io.err += t;
        },
    };
    return io;
}

let dir: string;
let emulator: Awaited<ReturnType<typeof startEmulator>>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sdk-cmd-"));
    emulator = await startEmulator();
});

afterEach(async () => {
    await new Promise<void>((r) => emulator.server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
});

describe("runSdkCommand", () => {
    test("discover: signs with the env secret and returns the schema (exit 0)", async () => {
        const io = captureIo({ AUTONOMA_SHARED_SECRET: SECRET });
        const code = await runSdkCommand(["discover", "--url", emulator.url], io);

        expect(code).toBe(0);
        const parsed: { ok: boolean; body: { scenarios: string[] } } = JSON.parse(io.out);
        expect(parsed.ok).toBe(true);
        expect(parsed.body.scenarios).toEqual(["standard"]);
    });

    test("up: reads a recipe file and returns a refsToken (exit 0)", async () => {
        const recipeFile = join(dir, "slice.json");
        await writeFile(
            recipeFile,
            JSON.stringify({ create: { User: [{ _alias: "u1", email: "a@b.com" }] } }),
            "utf-8",
        );

        const io = captureIo({ AUTONOMA_SHARED_SECRET: SECRET });
        const code = await runSdkCommand(["up", "--url", emulator.url, "--recipe", recipeFile], io);

        expect(code).toBe(0);
        const parsed: { ok: boolean; body: { refsToken: string } } = JSON.parse(io.out);
        expect(parsed.body.refsToken).toBe("tok-123");
    });

    test("up: accepts a full recipe envelope too", async () => {
        const recipeFile = join(dir, "recipe.json");
        await writeFile(recipeFile, JSON.stringify({ recipes: [{ create: { User: [{ _alias: "u1" }] } }] }), "utf-8");

        const io = captureIo({ AUTONOMA_SHARED_SECRET: SECRET });
        const code = await runSdkCommand(["up", "--url", emulator.url, "--recipe", recipeFile], io);

        expect(code).toBe(0);
    });

    test("up: substitutes the built-in tokens before POSTing, and reports what it substituted", async () => {
        const recipeFile = join(dir, "slice.json");
        await writeFile(
            recipeFile,
            JSON.stringify({
                create: {
                    User: [{ _alias: "u1", email: "admin+{{testRunId}}@acme.test", slug: "{{testRunShortId}}" }],
                },
            }),
            "utf-8",
        );

        const io = captureIo({ AUTONOMA_SHARED_SECRET: SECRET });
        const code = await runSdkCommand(
            ["up", "--url", emulator.url, "--recipe", recipeFile, "--test-run-id", "run-abc"],
            io,
        );

        expect(code).toBe(0);
        const sentUser = emulator.lastUp()?.create?.User?.[0];
        expect(sentUser?.email).toBe("admin+run-abc@acme.test");
        expect(sentUser?.slug).toMatch(/^[0-9a-f]{8}$/);

        const parsed: { testRunId: string; resolvedVariables: Record<string, string> } = JSON.parse(io.out);
        expect(parsed.testRunId).toBe("run-abc");
        expect(parsed.resolvedVariables.testRunId).toBe("run-abc");
        expect(parsed.resolvedVariables.testRunShortId).toBe(sentUser?.slug);
    });

    test("up: two runs of the same recipe seed different values for the tokenized fields", async () => {
        const recipeFile = join(dir, "slice.json");
        await writeFile(
            recipeFile,
            JSON.stringify({ create: { User: [{ email: "admin+{{testRunId}}@acme.test" }] } }),
            "utf-8",
        );

        const io = captureIo({ AUTONOMA_SHARED_SECRET: SECRET });
        await runSdkCommand(["up", "--url", emulator.url, "--recipe", recipeFile, "--test-run-id", "run-a"], io);
        const first = emulator.lastUp()?.create?.User?.[0]?.email;
        await runSdkCommand(["up", "--url", emulator.url, "--recipe", recipeFile, "--test-run-id", "run-b"], io);
        const second = emulator.lastUp()?.create?.User?.[0]?.email;

        expect(first).toBe("admin+run-a@acme.test");
        expect(second).toBe("admin+run-b@acme.test");
    });

    test("up: a token Autonoma does not substitute fails before the request (exit 1)", async () => {
        const recipeFile = join(dir, "slice.json");
        await writeFile(recipeFile, JSON.stringify({ create: { User: [{ email: "{{ownerEmail}}" }] } }), "utf-8");

        const io = captureIo({ AUTONOMA_SHARED_SECRET: SECRET });
        const code = await runSdkCommand(["up", "--url", emulator.url, "--recipe", recipeFile], io);

        expect(code).toBe(1);
        expect(io.err).toContain("Unknown recipe variable: ownerEmail");
        expect(emulator.lastUp()).toBeUndefined();
    });

    test("up: resolves a token the recipe declares in its own variables block", async () => {
        const recipeFile = join(dir, "slice.json");
        await writeFile(
            recipeFile,
            JSON.stringify({
                create: { User: [{ email: "{{ownerEmail}}" }] },
                variables: { ownerEmail: { strategy: "literal", value: "owner@acme.test" } },
            }),
            "utf-8",
        );

        const io = captureIo({ AUTONOMA_SHARED_SECRET: SECRET });
        const code = await runSdkCommand(["up", "--url", emulator.url, "--recipe", recipeFile], io);

        expect(code).toBe(0);
        expect(emulator.lastUp()?.create?.User?.[0]?.email).toBe("owner@acme.test");
    });

    test("down: takes a refs-token (exit 0)", async () => {
        const io = captureIo({ AUTONOMA_SHARED_SECRET: SECRET });
        const code = await runSdkCommand(["down", "--url", emulator.url, "--refs-token", "tok-123"], io);

        expect(code).toBe(0);
    });

    test("wrong secret is rejected by the endpoint (exit 1)", async () => {
        const io = captureIo({ AUTONOMA_SHARED_SECRET: "not-the-secret" });
        const code = await runSdkCommand(["discover", "--url", emulator.url], io);

        expect(code).toBe(1);
        const parsed: { ok: boolean; status: number } = JSON.parse(io.out);
        expect(parsed.ok).toBe(false);
        expect(parsed.status).toBe(401);
    });

    test("missing secret is a usage error (exit 2)", async () => {
        const io = captureIo({});
        const code = await runSdkCommand(["discover", "--url", emulator.url], io);

        expect(code).toBe(2);
        expect(io.err).toMatch(/AUTONOMA_SHARED_SECRET/);
    });

    test("missing --url is a usage error (exit 2)", async () => {
        const io = captureIo({ AUTONOMA_SHARED_SECRET: SECRET });
        const code = await runSdkCommand(["discover"], io);

        expect(code).toBe(2);
    });

    test("unknown action is a usage error (exit 2)", async () => {
        const io = captureIo({ AUTONOMA_SHARED_SECRET: SECRET });
        const code = await runSdkCommand(["frobnicate", "--url", emulator.url], io);

        expect(code).toBe(2);
    });

    test("--timeout override is accepted (exit 0)", async () => {
        const recipeFile = join(dir, "slice.json");
        await writeFile(recipeFile, JSON.stringify({ create: { User: [{ _alias: "u1" }] } }), "utf-8");

        const io = captureIo({ AUTONOMA_SHARED_SECRET: SECRET });
        const code = await runSdkCommand(["up", "--url", emulator.url, "--recipe", recipeFile, "--timeout", "300"], io);

        expect(code).toBe(0);
    });

    test("invalid --timeout is a usage error (exit 2)", async () => {
        const io = captureIo({ AUTONOMA_SHARED_SECRET: SECRET });
        const code = await runSdkCommand(["discover", "--url", emulator.url, "--timeout", "nope"], io);

        expect(code).toBe(2);
        expect(io.err).toMatch(/--timeout/);
    });
});
