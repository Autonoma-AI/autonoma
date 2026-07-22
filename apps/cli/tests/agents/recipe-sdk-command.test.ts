import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSdkCommand, type SdkCommandIo } from "../../src/agents/04-recipe-builder/sdk-command";

const SECRET = "sdk-cmd-secret";

/** A signed-endpoint emulator: verifies x-signature against SECRET, then answers
 *  per action (up returns a refsToken). Mirrors the SDK handler's wire contract. */
function startEmulator(): Promise<{ server: Server; url: string }> {
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            const sigOk = req.headers["x-signature"] === createHmac("sha256", SECRET).update(raw).digest("hex");
            if (!sigOk) return void res.writeHead(401).end(JSON.stringify({ error: "bad signature" }));
            const action = String((JSON.parse(raw) as { action?: unknown }).action ?? "");
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
            resolve({ server, url: `http://127.0.0.1:${port}/api/autonoma` });
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
let emulator: { server: Server; url: string };

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
