import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { ClassifierDeps } from "../../src/classify/dependencies";
import { buildClassifierTools } from "../../src/classify/tools";

const TOOL_OPTIONS = { toolCallId: "test-call", messages: [] };

function makeDeps(overrides: Partial<ClassifierDeps> = {}): ClassifierDeps {
    return {
        codebase: {
            readFile: async () => "file contents",
            grep: async () => "match",
            diff: async () => "the diff",
            diffStat: async () => "1 file changed",
        },
        run: {
            success: false,
            finishReason: "stalled",
            stepCount: 0,
            steps: [],
            startEpoch: 0,
            endEpoch: 0,
            stepScreenshots: [],
        },
        preview: { getEnvVarNames: async () => [], runScript: async () => "" },
        loadBaseline: async () => "the baseline",
        loadAppLogs: async () => "the logs",
        loadDeploymentHealth: async () => "the health",
        reasoningModel: new MockLanguageModelV3({}),
        visionModel: new MockLanguageModelV3({}),
        maxSteps: 10,
        ...overrides,
    };
}

describe("buildClassifierTools", () => {
    it("exposes the full investigator tool set", () => {
        const tools = buildClassifierTools(makeDeps());
        expect(Object.keys(tools).sort()).toEqual(
            [
                "analyze_screenshot",
                "analyze_video",
                "get_app_logs",
                "get_deployment_health",
                "get_preview_env",
                "git_diff",
                "grep_code",
                "prior_runs",
                "read_code",
                "run_script",
                "view_step_screenshot",
            ].sort(),
        );
    });

    it("prior_runs delegates to the injected baseline loader", async () => {
        const tools = buildClassifierTools(makeDeps({ loadBaseline: async () => "passed 3/3" }));
        await expect(tools.prior_runs?.execute?.({}, TOOL_OPTIONS)).resolves.toBe("passed 3/3");
    });

    it("run_script surfaces a harness error instead of throwing", async () => {
        const tools = buildClassifierTools(
            makeDeps({
                preview: {
                    getEnvVarNames: async () => [],
                    runScript: async () => {
                        throw new Error("no repo");
                    },
                },
            }),
        );
        await expect(tools.run_script?.execute?.({ script: "console.log(1)" }, TOOL_OPTIONS)).resolves.toContain(
            "Script harness error: no repo",
        );
    });

    it("get_preview_env explains absence as a config gap", async () => {
        const tools = buildClassifierTools(
            makeDeps({ preview: { getEnvVarNames: async () => [], runScript: async () => "" } }),
        );
        await expect(tools.get_preview_env?.execute?.({}, TOOL_OPTIONS)).resolves.toContain(
            "falls back to code defaults",
        );
    });

    it("analyze_video reports gracefully when there is no video", async () => {
        const tools = buildClassifierTools(makeDeps());
        await expect(tools.analyze_video?.execute?.({ question: "what happened?" }, TOOL_OPTIONS)).resolves.toBe(
            "No video recorded for this run.",
        );
    });
});
