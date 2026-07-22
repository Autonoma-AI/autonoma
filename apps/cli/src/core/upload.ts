import { readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { glob } from "glob";
import type { AppConfig } from "../config";
import * as p from "../ui/prompts";
import { debugLog } from "./debug";
import { loadGitInfo } from "./git";

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
    const files: UploadFile[] = [];
    for (const name of ARTIFACT_FILES) {
        try {
            const content = await readFile(join(outputDir, name), "utf-8");
            files.push({ name, content });
        } catch (err) {
            // Not every run produces every artifact (e.g. no entity audit); skip
            // the ones that aren't on disk.
            debugLog(`Artifact ${name} not on disk; skipping upload`, { err });
        }
    }
    return files;
}

async function readTestCases(outputDir: string): Promise<UploadFile[]> {
    const testsDir = join(outputDir, "qa-tests");
    const matches = await glob("**/*.md", { cwd: testsDir, nodir: true });

    const files: UploadFile[] = [];
    for (const match of matches) {
        const name = basename(match);
        if (name === "INDEX.md") continue;

        const content = await readFile(join(testsDir, match), "utf-8");
        const folderPath = relative(".", match).split("/").slice(0, -1).join("/");
        files.push({ name, content, folder: folderPath.length > 0 ? folderPath : undefined });
    }
    return files;
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

    if (autonomaApiUrl == null || autonomaApiToken == null || autonomaGenerationId == null) {
        p.log.info(
            "Autonoma upload credentials not configured - artifacts saved locally only. " +
                `They live in ${outputDir}.`,
        );
        return;
    }

    const baseUrl = autonomaApiUrl.replace(/\/+$/, "");
    const setupUrl = `${baseUrl}/v1/setup/setups/${autonomaGenerationId}`;

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

    p.log.success(
        `Uploaded ${testCases.length} test case${testCases.length === 1 ? "" : "s"} and ` +
            `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}. ` +
            "Return to your browser to continue onboarding.",
    );
}
