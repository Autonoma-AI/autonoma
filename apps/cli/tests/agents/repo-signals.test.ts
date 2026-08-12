import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectRepoSignals } from "../../src/agents/01-kb-generator/repo-signals";

/**
 * These build a real git repo with a controlled history and assert what enters
 * the window the KB agent sees. The bug they guard: on a monorepo the window was
 * chosen by raw churn with no filtering, so lockfiles and generated code took the
 * top slots and a fragile-but-smaller product surface got evicted by a large but
 * stable one. Behavioral, not structural - they check which paths survive and in
 * what order, never how the ranking is computed.
 */

const DAY_MS = 86_400_000;

let repo: string;

function run(args: string[], env?: NodeJS.ProcessEnv): void {
    execFileSync("git", args, { cwd: repo, env: { ...process.env, ...env }, stdio: "ignore" });
}

/** Commit a change to one file, dated `daysAgo` before now so it lands inside the 18-month window. */
function commitFile(path: string, daysAgo: number): void {
    const abs = join(repo, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `content ${daysAgo}\n`);
    const iso = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
    run(["add", "--", path]);
    run(["commit", "-m", `touch ${path}`, "--no-verify"], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

/** Touch a file on each of the given day-offsets (newest first is irrelevant to retouch counting). */
function touchOn(path: string, daysAgoList: number[]): void {
    for (const daysAgo of daysAgoList) commitFile(path, daysAgo);
}

beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "repo-signals-"));
    run(["init", "-q"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    run(["config", "commit.gpgsign", "false"]);

    // Product surface, small but fragile: 5 touches, all within a week of each
    // other -> 4 retouches. This is the surface the signal exists to find.
    touchOn("apps/web/components/checkout.tsx", [40, 39, 38, 37, 36]);

    // Product surface, larger but stable: 7 touches spaced >1 week apart -> 0
    // retouches. Higher churn than the fragile file; must NOT out-rank it.
    touchOn("apps/web/components/dashboard.tsx", [200, 180, 160, 140, 120, 100, 80]);

    // Product backend that plausibly feeds the UI: kept, not filtered.
    touchOn("apps/api/services/orders.ts", [30, 29, 28]);

    // Noise: a lockfile is the single most-changed path here, and would take slot
    // #1 under the old churn ranking. Must be absent.
    touchOn("pnpm-lock.yaml", [60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50]);

    // Noise: generated code, IaC, CI config, tests, build output.
    touchOn("apps/api/generated/client.ts", [45, 44, 43, 42]);
    touchOn("infra/terraform/main.tf", [70, 69, 68, 67]);
    touchOn(".github/workflows/ci.yml", [75, 74, 73]);
    touchOn("apps/web/components/checkout.test.ts", [36, 35, 34]);
    touchOn("dist/bundle.js", [20, 19, 18]);
});

afterAll(() => {
    if (repo != null) rmSync(repo, { recursive: true, force: true });
});

describe("collectRepoSignals", () => {
    it("keeps product code in the window and filters out infra noise", async () => {
        const signals = await collectRepoSignals(repo);
        expect(signals).toBeDefined();
        const paths = signals!.files.map((f) => f.path);

        expect(paths).toContain("apps/web/components/checkout.tsx");
        expect(paths).toContain("apps/web/components/dashboard.tsx");
        expect(paths).toContain("apps/api/services/orders.ts");

        expect(paths).not.toContain("pnpm-lock.yaml");
        expect(paths).not.toContain("apps/api/generated/client.ts");
        expect(paths).not.toContain("infra/terraform/main.tf");
        expect(paths).not.toContain(".github/workflows/ci.yml");
        expect(paths).not.toContain("apps/web/components/checkout.test.ts");
        expect(paths).not.toContain("dist/bundle.js");
    });

    it("ranks a fragile surface above a higher-churn but stable one", async () => {
        const signals = await collectRepoSignals(repo);
        const paths = signals!.files.map((f) => f.path);

        const fragile = paths.indexOf("apps/web/components/checkout.tsx");
        const stable = paths.indexOf("apps/web/components/dashboard.tsx");
        expect(fragile).toBeGreaterThanOrEqual(0);
        expect(stable).toBeGreaterThanOrEqual(0);
        // Retouch, not churn, decides the window: the fragile file wins despite
        // fewer total commits than the stable hub.
        expect(fragile).toBeLessThan(stable);

        const checkout = signals!.files.find((f) => f.path === "apps/web/components/checkout.tsx");
        const dashboard = signals!.files.find((f) => f.path === "apps/web/components/dashboard.tsx");
        expect(checkout!.retouches).toBeGreaterThan(dashboard!.retouches);
        expect(dashboard!.commits).toBeGreaterThan(checkout!.commits);
    });
});

/**
 * The monorepo crowding fix: the `git log` sees the whole repo, so a busy sibling
 * app can out-rank and evict the frontend under test. When called with the app's
 * own subdirectory as its root, the window must reserve most of its slots for that
 * app while still keeping the highest-signal code from the rest of the repo.
 */
describe("collectRepoSignals on a monorepo (frontend under test is a subdirectory)", () => {
    let mono: string;

    function monoRun(args: string[], env?: NodeJS.ProcessEnv): void {
        execFileSync("git", args, { cwd: mono, env: { ...process.env, ...env }, stdio: "ignore" });
    }
    function monoCommit(path: string, daysAgo: number): void {
        const abs = join(mono, path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, `content ${daysAgo}\n`);
        const iso = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
        monoRun(["add", "--", path]);
        monoRun(["commit", "-m", `touch ${path}`, "--no-verify"], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
    }

    beforeAll(() => {
        mono = mkdtempSync(join(tmpdir(), "repo-signals-mono-"));
        const repo = mono;
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
        execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });

        // A sibling backend service, busier than anything in the frontend: on the
        // whole-repo ranking it would sit at the very top and take many slots.
        for (let i = 0; i < 8; i++) monoCommit(`services/api/src/handler-${i}.py`, 300 - i);
        monoCommit("services/api/src/hot.py", 50);
        monoCommit("services/api/src/hot.py", 49);
        monoCommit("services/api/src/hot.py", 48);

        // The frontend under test: 40 modestly-corrected files. Each is a genuine
        // product surface but individually less busy than the sibling's hot files.
        for (let i = 0; i < 40; i++) {
            monoCommit(`apps/web/components/feature-${String(i).padStart(2, "0")}.tsx`, 60 - (i % 20));
            monoCommit(`apps/web/components/feature-${String(i).padStart(2, "0")}.tsx`, 58 - (i % 20));
        }
    });

    afterAll(() => {
        if (mono != null) rmSync(mono, { recursive: true, force: true });
    });

    it("reserves most of the window for the app under test but keeps top sibling signal", async () => {
        const signals = await collectRepoSignals(join(mono, "apps/web"));
        expect(signals).toBeDefined();
        const paths = signals!.files;
        expect(paths.length).toBe(40);

        const frontend = paths.filter((f) => f.path.startsWith("apps/web/"));
        const sibling = paths.filter((f) => f.path.startsWith("services/"));

        // The frontend must dominate the window (reserved share), not be crowded out...
        expect(frontend.length).toBeGreaterThanOrEqual(34);
        // ...yet the busiest sibling code still earns a place (backend-feeds-UI signal).
        expect(sibling.length).toBeGreaterThan(0);
        expect(sibling.some((f) => f.path === "services/api/src/hot.py")).toBe(true);
    });
});
