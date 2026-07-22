import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Step-04 is interactive; mock the clack layer so it runs headless. The handoff is
// opt-in-with-yes-default, so confirm returns true; the permission mode and agent
// are pre-seeded in state, so no select is ever reached.
vi.mock("@clack/prompts", () => ({
    confirm: vi.fn(() => Promise.resolve(true)),
    select: vi.fn(() => Promise.resolve(undefined)),
    text: vi.fn(() => Promise.resolve("")),
    isCancel: () => false,
    note: vi.fn(),
    log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock("../../src/core/notify", () => ({ notify: vi.fn() }));

import { COMPLETION_MARKER_FILE } from "../../src/agents/04-recipe-builder/completion";
import { runRecipeBuilder } from "../../src/agents/04-recipe-builder/index";
import type { AgentLauncher } from "../../src/agents/04-recipe-builder/launcher";
import { RECIPE_FILE } from "../../src/agents/04-recipe-builder/recipe";
import type { RecipeBuilderState } from "../../src/agents/04-recipe-builder/state";
import type { AppConfig } from "../../src/config";

interface FakeSpec {
    exitCode: number;
    available?: boolean;
    /** Whether the agent writes the completion marker (a finished session does). */
    writeMarker: boolean;
    outputDir: string;
}

/** A fake AgentLauncher standing in for the developer's local agent: sets its exit
 *  code and (maybe) writes the completion marker, without a real TTY or subscription. */
function fakeLauncher(spec: FakeSpec): AgentLauncher & { calls: number } {
    const launcher = {
        calls: 0,
        id: "fake",
        label: "Fake Agent",
        isAvailable: () => Promise.resolve(spec.available ?? true),
        async launch(): Promise<number> {
            launcher.calls++;
            if (spec.writeMarker) {
                await writeFile(
                    join(spec.outputDir, COMPLETION_MARKER_FILE),
                    JSON.stringify({ complete: true }),
                    "utf-8",
                );
            }
            return spec.exitCode;
        },
    };
    return launcher;
}

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "recipe-handoff-"));
    // No upload credentials -> submit no-ops (it needs all of api url/token/generation id).
    delete process.env.AUTONOMA_GENERATION_ID;
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.clearAllMocks();
});

/** Seed the output dir at the `handoff` phase: audit + a recipe the agent "generated" + state. */
async function seedHandoffPhase(withAgent: boolean): Promise<void> {
    await writeFile(
        join(dir, "entity-audit.md"),
        `---\nmodels:\n  - name: User\n    independently_created: true\n    creation_file: src/user.ts\n    creation_function: createUser\n    created_by: []\n---\n# audit\n`,
        "utf-8",
    );
    await writeFile(
        join(dir, RECIPE_FILE),
        JSON.stringify({
            version: 1,
            source: { discoverPath: "discover.json", scenariosPath: "scenarios.md" },
            validationMode: "endpoint-lifecycle",
            recipes: [
                {
                    name: "standard",
                    description: "d",
                    create: { User: [{ _alias: "user_1", email: "a@b.com" }] },
                    validation: { status: "validated", method: "endpoint-up-down" },
                },
            ],
        }),
        "utf-8",
    );
    const state: RecipeBuilderState = {
        phase: "handoff",
        entityOrder: ["User"],
        entities: { User: { entityName: "User", status: "recipe-accepted", errorLog: [] } },
        sharedSecret: "handoff-test-secret",
        permissionMode: "bypassPermissions",
    };
    if (withAgent) state.agentId = "fake";
    await writeFile(join(dir, ".recipe-builder-state.json"), JSON.stringify(state), "utf-8");
}

function baseInput(launcher: AgentLauncher) {
    const config: AppConfig = { projectRoot: dir, projectSlug: "test" };
    return { projectRoot: dir, outputDir: dir, config, launchers: [launcher], cliCommand: "fake-cli" };
}

async function loadState(): Promise<RecipeBuilderState> {
    return JSON.parse(await readFile(join(dir, ".recipe-builder-state.json"), "utf-8"));
}

describe("runRecipeBuilder handoff + completion", () => {
    test("happy path: agent finishes and writes the completion marker -> recipe submitted", async () => {
        await seedHandoffPhase(true);
        const launcher = fakeLauncher({ exitCode: 0, writeMarker: true, outputDir: dir });

        const result = await runRecipeBuilder(baseInput(launcher));

        expect(result.success).toBe(true);
        expect(launcher.calls).toBe(1);
        expect((await loadState()).phase).toBe("done");
    });

    test("incomplete: agent exits without a completion marker -> bounded re-launch -> hand-back", async () => {
        await seedHandoffPhase(true);
        const launcher = fakeLauncher({ exitCode: 1, writeMarker: false, outputDir: dir });

        const result = await runRecipeBuilder(baseInput(launcher));

        expect(result.success).toBe(false);
        expect(result.paused).toBeFalsy(); // a hand-back, not a pause
        // One launch in the handoff phase + exactly one bounded re-launch in completion.
        expect(launcher.calls).toBe(2);
        expect((await loadState()).phase).toBe("completion"); // never advanced to submit
    });

    test("no supported agent -> manual fallback pauses without launching", async () => {
        await seedHandoffPhase(false);
        const launcher = fakeLauncher({ exitCode: 0, writeMarker: false, available: false, outputDir: dir });

        const result = await runRecipeBuilder(baseInput(launcher));

        expect(result.paused).toBe(true);
        expect(launcher.calls).toBe(0);
    });

    test("non-interactive: headless agent finishes -> recipe submitted", async () => {
        await seedHandoffPhase(true);
        const launcher = fakeLauncher({ exitCode: 0, writeMarker: true, outputDir: dir });

        const result = await runRecipeBuilder({ ...baseInput(launcher), nonInteractive: true });

        expect(result.success).toBe(true);
        expect(launcher.calls).toBe(1);
        expect((await loadState()).phase).toBe("done");
    });

    test("non-interactive with no agent -> hard error, not a pause", async () => {
        await seedHandoffPhase(false);
        const launcher = fakeLauncher({ exitCode: 0, writeMarker: false, available: false, outputDir: dir });

        const result = await runRecipeBuilder({ ...baseInput(launcher), nonInteractive: true });

        expect(result.success).toBe(false);
        expect(result.paused).toBeFalsy(); // hard error, not a resume-later pause
        expect(launcher.calls).toBe(0);
    });
});
