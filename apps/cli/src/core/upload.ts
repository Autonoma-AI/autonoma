import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config";
import * as p from "../ui/prompts";
import { debugLog } from "./debug";
import { loadGitInfo } from "./git";
import { listTestFiles } from "./test-files";

interface UploadFile {
    name: string;
    content: string;
    folder?: string;
}

// Mirrors the artifacts the web UI used to accept when the user uploaded the
// `~/.autonoma/<app>/` folder by hand. `recipe.json` is intentionally excluded:
// it is submitted through the versioned scenario-recipe endpoint during the
// recipe-builder step (see agents/04-recipe-builder/phases/submit.ts), and the
// generic artifacts endpoint rejects it.
const ARTIFACT_FILES = ["AUTONOMA.md", "scenarios.md", "entity-audit.md"];

async function readArtifacts(outputDir: string): Promise<UploadFile[]> {
    // Read together: no artifact depends on another, so reading them in sequence
    // only added round trips. The per-file catch stays inside the map, so one
    // missing artifact still skips just itself.
    const files = await Promise.all(
        ARTIFACT_FILES.map(async (name) => {
            try {
                return { name, content: await readFile(join(outputDir, name), "utf-8") };
            } catch (err) {
                // Not every run produces every artifact (e.g. no entity audit); skip
                // the ones that aren't on disk.
                debugLog(`Artifact ${name} not on disk; skipping upload`, { err });
                return undefined;
            }
        }),
    );
    return files.filter((file): file is UploadFile => file != null);
}

async function readTestCases(outputDir: string): Promise<UploadFile[]> {
    const testPaths = await listTestFiles(outputDir);

    // One read per test, all at once: a suite is hundreds of small files and no
    // read depends on another, so reading them in sequence spent the upload
    // waiting on the disk. Promise.all keeps listTestFiles' sorted order, which
    // the payload relies on being deterministic.
    return await Promise.all(
        testPaths.map(async (testPath) => {
            // Paths arrive as "qa-tests/<folder...>/<name>"; the platform wants the
            // folder relative to the suite root, so drop the leading segment.
            const segments = testPath.split("/").slice(1);
            const name = segments[segments.length - 1]!;
            const folder = segments.slice(0, -1).join("/");

            const content = await readFile(join(outputDir, testPath), "utf-8");
            return { name, content, folder: folder.length > 0 ? folder : undefined };
        }),
    );
}

async function postJson(url: string, token: string, body: unknown): Promise<void> {
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upload failed (HTTP ${res.status}): ${text}`);
    }
}

async function patchJson(url: string, token: string, body: unknown): Promise<void> {
    const res = await fetch(url, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to mark setup complete (HTTP ${res.status}): ${text}`);
    }
}

/**
 * Uploads the generated artifacts (test cases + knowledge base + scenarios) to
 * the Autonoma backend at the end of a run, then marks the setup complete so
 * the onboarding UI auto-advances. The recipe is submitted separately during
 * the recipe-builder step.
 *
 * No-ops when the upload credentials are not configured, so the CLI still runs
 * standalone (outside onboarding) and just leaves the artifacts on disk.
 */
export async function uploadArtifacts(config: AppConfig, outputDir: string): Promise<void> {
    const { autonomaApiUrl, autonomaApiToken, autonomaGenerationId } = config;

    if (autonomaApiToken == null || autonomaGenerationId == null) {
        p.log.info(
            "Autonoma upload credentials not configured - artifacts saved locally only. " +
                `They live in ${outputDir}.`,
        );
        return;
    }

    const setupUrl = `${autonomaApiUrl}/v1/setup/setups/${autonomaGenerationId}`;

    p.log.step("Uploading artifacts to Autonoma...");

    const [testCases, artifacts, gitInfo] = await Promise.all([
        readTestCases(outputDir),
        readArtifacts(outputDir),
        loadGitInfo(outputDir),
    ]);

    // commitSha lets the backend stamp the resulting snapshot (head_sha) and the
    // branch (last_handled_sha) with the commit the suite was generated from.
    await postJson(`${setupUrl}/artifacts`, autonomaApiToken, { testCases, artifacts, commitSha: gitInfo?.sha });
    await patchJson(setupUrl, autonomaApiToken, { status: "completed" });

    // Reports what landed and stops there. Where to go next is the closing summary's
    // job, and it is the only one of the two that knows whether there is a browser to
    // go back to - a headless run has neither that nor anyone to read the suggestion.
    p.log.success(
        `Uploaded ${testCases.length} test case${testCases.length === 1 ? "" : "s"} and ` +
            `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}.`,
    );
}
