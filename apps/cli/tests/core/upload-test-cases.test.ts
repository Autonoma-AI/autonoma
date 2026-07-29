import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { countGeneratedTests } from "../../src/core/count-generated-tests";
import { uploadArtifacts } from "../../src/core/upload";

interface UploadedTestCase {
    name: string;
    content: string;
    folder?: string;
}

let uploaded: UploadedTestCase[] = [];
let uploadedArtifacts: { name: string; content: string }[] = [];

beforeAll(() => {
    process.env.DONT_TRACK = "1";
});

describe("uploaded test cases", () => {
    let outputDir: string;

    async function writeTest(relPath: string, content = "---\ntitle: t\n---\n") {
        const abs = join(outputDir, "qa-tests", relPath);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf-8");
    }

    beforeEach(async () => {
        outputDir = await mkdtemp(join(tmpdir(), "upload-"));
        uploaded = [];
        uploadedArtifacts = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init: { body: string }) => {
                if (String(url).endsWith("/artifacts")) {
                    const body = JSON.parse(init.body);
                    uploaded = body.testCases;
                    uploadedArtifacts = body.artifacts;
                }
                return new Response("{}", { status: 200 });
            }),
        );
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        await rm(outputDir, { recursive: true });
    });

    async function upload() {
        await uploadArtifacts(
            {
                autonomaApiUrl: "https://api.example.com",
                autonomaApiToken: "token",
                autonomaGenerationId: "gen-1",
            } as Parameters<typeof uploadArtifacts>[0],
            outputDir,
        );
    }

    test("sends each test with its folder, and never the index", async () => {
        await writeTest("admin/users/create-user.md");
        await writeTest("top-level.md");
        await writeTest("INDEX.md");

        await upload();

        expect(uploaded).toEqual([
            { name: "create-user.md", content: expect.any(String), folder: "admin/users" },
            { name: "top-level.md", content: expect.any(String), folder: undefined },
        ]);
    });

    test("does not send quarantined tests", async () => {
        await writeTest("admin/create-user.md");
        await writeTest("_invalid/broken.md", "<!-- VALIDATION ERRORS: no steps -->\n---\ntitle: broken\n---\n");

        await upload();

        expect(uploaded.map((t) => t.name)).toEqual(["create-user.md"]);
        expect(uploaded.some((t) => t.content.includes("VALIDATION ERRORS"))).toBe(false);
    });

    test("stays in sorted order when many tests are read at once", async () => {
        // Parallel reads resolve out of order; the payload must not. Enough files
        // that a completion-ordered implementation would visibly scramble.
        const names = Array.from({ length: 25 }, (_, i) => `t-${String(i).padStart(2, "0")}.md`);
        for (const name of names) await writeTest(`admin/${name}`);

        await upload();

        expect(uploaded.map((t) => t.name)).toEqual(names);
    });

    test("a missing artifact skips only itself", async () => {
        await writeTest("admin/create-user.md");
        // Only two of the three artifacts exist.
        await writeFile(join(outputDir, "AUTONOMA.md"), "# kb", "utf-8");
        await writeFile(join(outputDir, "scenarios.md"), "# scenarios", "utf-8");

        await upload();

        expect(uploadedArtifacts.map((a) => a.name)).toEqual(["AUTONOMA.md", "scenarios.md"]);
    });

    test("the reported count matches what was uploaded", async () => {
        await writeTest("admin/create-user.md");
        await writeTest("admin/delete-user.md");
        await writeTest("_invalid/broken.md");
        await writeTest("INDEX.md");

        await upload();

        await expect(countGeneratedTests(outputDir)).resolves.toBe(uploaded.length);
        expect(uploaded).toHaveLength(2);
    });
});
