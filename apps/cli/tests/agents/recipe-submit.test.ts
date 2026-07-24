import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Neutralize the ~/.autonoma/.env fallback so the developer's own global env can never
// leak into (or rescue) these assertions - the project .env and shell env are enough here.
vi.mock("../../src/core/global-env", () => ({ loadGlobalEnv: () => {} }));

vi.mock("../../src/core/notify", () => ({ notify: vi.fn() }));

import { runRecipeBuilder } from "../../src/agents/04-recipe-builder/index";
import { RECIPE_FILE } from "../../src/agents/04-recipe-builder/recipe";
import type { RecipeBuilderState } from "../../src/agents/04-recipe-builder/state";
import { loadConfig } from "../../src/config";

const GENERATION_ID = "setup_123";

let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "recipe-submit-"));

    // Exactly the environment the onboarding page's launch command produces: a token
    // and a generation id, and deliberately NO AUTONOMA_API_URL.
    delete process.env.AUTONOMA_API_URL;
    process.env.AUTONOMA_API_TOKEN = "ask_test";
    process.env.AUTONOMA_GENERATION_ID = GENERATION_ID;

    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await seedSubmitPhase();
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTONOMA_API_URL;
    delete process.env.AUTONOMA_API_TOKEN;
    delete process.env.AUTONOMA_GENERATION_ID;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

/** Seed a run that finished its handoff and sits at the submit phase with a recipe on disk. */
async function seedSubmitPhase(): Promise<void> {
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
        phase: "submit",
        entityOrder: ["User"],
        entities: { User: { entityName: "User", status: "recipe-accepted", errorLog: [] } },
        sharedSecret: "submit-test-secret",
        permissionMode: "bypassPermissions",
    };
    await writeFile(join(dir, ".recipe-builder-state.json"), JSON.stringify(state), "utf-8");
}

async function runSubmitPhase() {
    return runRecipeBuilder({
        projectRoot: dir,
        outputDir: dir,
        config: loadConfig({ project: dir }),
        launchers: [],
        cliCommand: "fake-cli",
    });
}

async function loadState(): Promise<RecipeBuilderState> {
    return JSON.parse(await readFile(join(dir, ".recipe-builder-state.json"), "utf-8"));
}

describe("recipe submission", () => {
    test("uploads to production when only the onboarding env vars are set", async () => {
        const result = await runSubmitPhase();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe(`https://autonoma.app/v1/setup/setups/${GENERATION_ID}/scenario-recipe-versions`);
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body).recipes[0].name).toBe("standard");

        expect(result.success).toBe(true);
        expect((await loadState()).phase).toBe("done");
    });

    test("honours AUTONOMA_API_URL when it is set", async () => {
        process.env.AUTONOMA_API_URL = "https://alpha-abc.autonoma.app/";

        await runSubmitPhase();

        expect(fetchMock.mock.calls[0]![0]).toBe(
            `https://alpha-abc.autonoma.app/v1/setup/setups/${GENERATION_ID}/scenario-recipe-versions`,
        );
    });

    test("fails the step when the API rejects the recipe, leaving it resumable", async () => {
        fetchMock.mockResolvedValue(new Response("nope", { status: 400 }));

        const result = await runSubmitPhase();

        expect(result.success).toBe(false);
        expect((await loadState()).phase).toBe("submit");
    });

    test("stays green with no credentials so the planner still runs standalone", async () => {
        delete process.env.AUTONOMA_API_TOKEN;
        delete process.env.AUTONOMA_GENERATION_ID;

        const result = await runSubmitPhase();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect((await loadState()).phase).toBe("done");
    });
});
