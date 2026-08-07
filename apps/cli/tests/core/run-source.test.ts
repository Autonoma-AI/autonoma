import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `run_source` exists to make one query expressible: a front-door run that has
 * no generation id. Its correct answer is always zero, so the classification has
 * to key off something other than the generation id itself - otherwise the query
 * is a tautology and can never surface a dropped hand-off.
 *
 * Every test here sets an API token, because every real run has one: it is
 * required for standalone use too (`ensureAutonomaAuth`). Modelling a run
 * without it is what let an earlier version of this classifier treat the token
 * as an app-launched signal and mark every standalone run `front_door`.
 */
const APP_VARS = ["AUTONOMA_APPLICATION_ID", "AUTONOMA_API_TOKEN", "AUTONOMA_GENERATION_ID"] as const;

const originalEnv = { ...process.env };

beforeEach(() => {
    for (const key of APP_VARS) delete process.env[key];
    // The one variable every run has, app-launched or not.
    process.env.AUTONOMA_API_TOKEN = "ask_required_for_every_run";
    vi.resetModules();
});

afterEach(() => {
    process.env = { ...originalEnv };
});

async function runSource(): Promise<string> {
    const { getRuntimeContext } = await import("../../src/core/runtime-context");
    return getRuntimeContext().run_source;
}

describe("run_source", () => {
    test("an authenticated run in someone's own repo is standalone", async () => {
        // The regression: an API token is not evidence the app launched anything.
        expect(await runSource()).toBe("standalone");
    });

    test("the application id - which only the app's command supplies - marks it front_door", async () => {
        process.env.AUTONOMA_APPLICATION_ID = "app_123";
        expect(await runSource()).toBe("front_door");
    });

    test("a front-door run stays front_door with no generation id - the case worth alerting on", async () => {
        // The hand-off arrived with its app id but no generation id. Classifying
        // this as standalone would hide the bug among legitimate npx usage.
        process.env.AUTONOMA_APPLICATION_ID = "app_123";
        expect(process.env.AUTONOMA_GENERATION_ID).toBeUndefined();
        expect(await runSource()).toBe("front_door");
    });

    test("a generation id alone does not make it front_door - classification is independent", async () => {
        process.env.AUTONOMA_GENERATION_ID = "gen_123";
        expect(await runSource()).toBe("standalone");
    });

    test("an empty application id is not an application id", async () => {
        process.env.AUTONOMA_APPLICATION_ID = "   ";
        expect(await runSource()).toBe("standalone");
    });
});
