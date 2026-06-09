import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloneRepositoryParams, FakeGitHubInstallationClient } from "@autonoma/github";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Codebase } from "../src/codebase";

let fixtureDir: string;

beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "codebase-fixture-"));
    await fs.mkdir(join(fixtureDir, "src"));
    await fs.writeFile(join(fixtureDir, "README.md"), "# Test fixture\n");
});

afterAll(async () => {
    if (fixtureDir != null) await fs.rm(fixtureDir, { recursive: true, force: true });
});

async function makeCodebase(): Promise<Codebase> {
    const targetDir = await mkdtemp(join(tmpdir(), "codebase-target-"));
    await fs.cp(fixtureDir, targetDir, { recursive: true });
    return new Codebase(targetDir);
}

describe("Codebase", () => {
    it("exposes the on-disk root the bash tool runs against", async () => {
        const codebase = await makeCodebase();
        try {
            const readme = await fs.readFile(join(codebase.root, "README.md"), "utf-8");
            expect(readme).toContain("Test fixture");
        } finally {
            await codebase.dispose();
        }
    });

    it("dispose removes the on-disk clone", async () => {
        const codebase = await makeCodebase();
        await codebase.dispose();
        await expect(fs.access(codebase.root)).rejects.toThrow();
    });

    it("clone clears a dangling target tree before cloning", async () => {
        const targetDir = await mkdtemp(join(tmpdir(), "codebase-dangling-"));
        const danglingFile = join(targetDir, "stale-from-previous-run.txt");
        await fs.writeFile(danglingFile, "leftover\n");

        const client = new ClearTrackingGitHubClient(danglingFile);
        const codebase = await Codebase.clone(client, targetDir, { repoName: "owner/repo", commitSha: "abc123" });

        try {
            // The fake records whether the dangling file survived into the clone
            // call - it must not, because clone() rimrafs the target first.
            expect(client.danglingFileSurvived).toBe(false);
            const readme = await fs.readFile(join(codebase.root, "README.md"), "utf-8");
            expect(readme).toContain("cloned fixture");
        } finally {
            await codebase.dispose();
        }
    });
});

/**
 * Fake client whose `cloneRepository` records whether a known dangling file
 * still existed at clone time (it should not - `Codebase.clone` clears the
 * target first), then populates the target dir with a minimal fixture.
 */
class ClearTrackingGitHubClient extends FakeGitHubInstallationClient {
    public danglingFileSurvived = true;

    constructor(private readonly danglingFile: string) {
        super();
    }

    override async cloneRepository(params: CloneRepositoryParams): Promise<string> {
        this.danglingFileSurvived = await fs
            .access(this.danglingFile)
            .then(() => true)
            .catch(() => false);

        await fs.mkdir(params.targetDir, { recursive: true });
        await fs.writeFile(join(params.targetDir, "README.md"), "# cloned fixture\n");
        return params.targetDir;
    }
}
