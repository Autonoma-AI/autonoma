import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CostCollector } from "@autonoma/ai";
import {
    ExecutionAgentRunner,
    type ExecutionResult,
    buildExecutionPrompt,
    createEngineModelRegistry,
    toLeanStep,
} from "@autonoma/engine";
import { Evaluation, type LoadedCase, type RunCaseHelpers } from "@autonoma/evals";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger } from "@autonoma/logger";
import { provisionScenarioInstance, teardownScenarioInstance, type ProvisionedInstance } from "@autonoma/scenario";
import { chromium } from "playwright";
import { expect } from "vitest";
import type { WebCommandSpec } from "../../src/execution-agent/web-agent";
import { createWebAgentFactory } from "../../src/execution-agent/web-agent";
import type { WebApplicationData, WebContext } from "../../src/platform";
import { env } from "../../src/platform/env";
import { buildWebApplicationData } from "../../src/platform/web-application-data-builder";
import { WebInstaller } from "../../src/platform/web-installer";
import {
    buildScenarioData,
    coerceScenarioVariables,
    resolveSigningSecret,
    saveCaseArtifacts,
    summarizeRunCost,
    writeCaseResult,
} from "../shared/eval-utils";
import { type GenerationEvalFrontmatter, checkGenerationResult } from "./generation-frontmatter";
import type { GenerationEvalInput } from "./generation-input";
import { GenerationJudge } from "./generation-judge";

export type GenerationEvalCase = LoadedCase<GenerationEvalInput, GenerationEvalFrontmatter>;

const CASE_TIMEOUT_MS = 600_000;
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");

setScreenshotConfig({ screenResolution: DEFAULT_VIEWPORT, architecture: "web" });

/**
 * Thin ExecutionAgentRunner subclass that exposes seedMemory publicly so the
 * eval harness can inject credentials without going through the DB-coupled
 * GenerationAPIRunner path.
 */
class EvalAgentRunner extends ExecutionAgentRunner<WebCommandSpec, WebApplicationData, WebContext> {
    public seedMemoryEntries(entries: Record<string, string>): void {
        this.seedMemory(entries);
    }

    public async getFinalVideoPath(): Promise<string | undefined> {
        if (this.videoRecorder == null) return undefined;
        try {
            return await this.videoRecorder.getVideoPath();
        } catch (err) {
            this.logger.warn("Could not recover video path after timeout", { extra: { err } });
            return undefined;
        }
    }
}

export class GenerationEvaluation extends Evaluation<GenerationEvalCase> {
    private readonly logger = rootLogger.child({ name: this.constructor.name });
    private readonly judge = new GenerationJudge();

    constructor(resultsDir: string, cases: GenerationEvalCase[]) {
        super(
            {
                name: "web-generation",
                parallel: false,
                testOptions: { timeout: CASE_TIMEOUT_MS },
                resultsDir,
            },
            cases,
        );
    }

    protected override caseName(testCase: GenerationEvalCase): string {
        const note = testCase.frontmatter.description;
        return note != null ? `${testCase.name} - ${note}` : testCase.name;
    }

    protected override testCaseInfo(testCase: GenerationEvalCase): Record<string, string> {
        const info: Record<string, string> = {
            case: testCase.name,
            applicationId: testCase.input.applicationId,
            url: testCase.input.url,
        };
        if (testCase.input.generationId != null) {
            info.generationId = testCase.input.generationId;
        }
        return info;
    }

    protected override async runCase(
        testCase: GenerationEvalCase,
        addInfo: (info: Record<string, unknown>) => void,
        helpers: RunCaseHelpers,
    ): Promise<void> {
        if (testCase.frontmatter.skip === true) {
            helpers.skip("case marked skip: true in expected.md frontmatter");
        }

        const caseData: Record<string, unknown> = {};
        const recordInfo = (info: Record<string, unknown>) => {
            Object.assign(caseData, info);
            addInfo(info);
        };

        const { input, frontmatter, rubric } = testCase;
        const signingSecret = resolveSigningSecret(input, helpers, testCase.name);
        const provisionedInstance = await this.provisionScenario(input, signingSecret, helpers, testCase.name);
        const scenarioData = buildScenarioData(provisionedInstance, input, this.logger);

        const browser = await chromium.launch({ headless: true });
        const browserContext = await browser.newContext({
            viewport: DEFAULT_VIEWPORT,
            recordVideo: { dir: os.tmpdir() },
        });
        const installer = new WebInstaller(browser, browserContext, env.NATIVE_DIALOGS_ENABLED);

        let result: ExecutionResult<WebCommandSpec> | undefined;
        let videoPath: string | undefined;
        let runner: EvalAgentRunner | undefined;
        let agentTimedOut = false;
        const costCollector = new CostCollector();

        const AGENT_RUN_TIMEOUT_MS = CASE_TIMEOUT_MS - 30_000;

        try {
            const webAppData = await buildWebApplicationData({
                url: input.url,
                file: input.file,
                auth: provisionedInstance?.auth,
                customHeaders: input.customHeaders,
                previewkitBypassToken: input.previewkitBypassToken,
            });

            const credentials = provisionedInstance?.auth?.credentials;
            const resolvedVariables =
                provisionedInstance?.resolvedVariables != null
                    ? coerceScenarioVariables(provisionedInstance.resolvedVariables)
                    : undefined;

            const prompt = buildExecutionPrompt(
                input.rawPrompt,
                input.customInstructions,
                credentials,
                resolvedVariables,
                input.url,
            );
            runner = new EvalAgentRunner({
                installer,
                executionAgentFactory: createWebAgentFactory(createEngineModelRegistry(costCollector)),
                eventHandlers: {
                    frame: async () => {},
                    beforeStep: async () => {},
                    attempt: async () => {},
                },
            });

            await runner.setupAgent({ name: testCase.name, prompt, ...webAppData }, prompt);

            if (credentials != null && Object.keys(credentials).length > 0) {
                runner.seedMemoryEntries(credentials);
            }
            if (resolvedVariables != null && Object.keys(resolvedVariables).length > 0) {
                runner.seedMemoryEntries(resolvedVariables);
            }

            const agentRunPromise = runner.run();
            agentRunPromise.catch(() => {});

            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("eval-agent-timeout")), AGENT_RUN_TIMEOUT_MS),
            );

            try {
                const runResult = await Promise.race([agentRunPromise, timeoutPromise]);
                result = runResult.result;
                videoPath = runResult.videoPath;
            } catch (err) {
                if (err instanceof Error && err.message === "eval-agent-timeout") {
                    agentTimedOut = true;
                    this.logger.warn("Agent run timed out - closing browser to finalize video", {
                        extra: { case: testCase.name, timeoutMs: AGENT_RUN_TIMEOUT_MS },
                    });
                    await installer.cleanup().catch((e: unknown) => {
                        this.logger.warn("Browser cleanup on timeout failed", { extra: { e } });
                    });
                    await agentRunPromise.catch(() => {});
                    videoPath = await runner.getFinalVideoPath();
                } else {
                    throw err;
                }
            }

            if (result != null) {
                this.logger.info("Agent finished", {
                    extra: {
                        case: testCase.name,
                        finishReason: result.finishReason,
                        steps: result.generatedSteps.length,
                    },
                });
            }
        } finally {
            if (!agentTimedOut) {
                try {
                    await installer.cleanup();
                } catch (err) {
                    this.logger.warn("Browser cleanup failed", { extra: { case: testCase.name, err } });
                }
            }

            if (provisionedInstance != null && input.sdkUrl != null && signingSecret != null) {
                await teardownScenarioInstance({
                    instanceId: provisionedInstance.instanceId,
                    sdkUrl: input.sdkUrl,
                    signingSecret,
                    customHeaders: input.customHeaders,
                    refs: provisionedInstance.refs,
                    refsToken: provisionedInstance.refsToken,
                    applicationId: input.applicationId,
                }).catch((err: unknown) => {
                    this.logger.warn("Scenario teardown failed", { extra: { case: testCase.name, err } });
                });
            }

            // Save artifacts in finally so they're written even on timeout.
            if (videoPath != null) {
                const dir = saveCaseArtifacts(RESULTS_DIR, testCase.name, videoPath);
                const runData: Record<string, unknown> = {
                    videoPath: path.join(dir, "recording.webm"),
                    agentCost: summarizeRunCost(costCollector),
                    timedOut: agentTimedOut,
                };
                if (result != null) {
                    runData.finishReason = result.finishReason;
                    runData.stepCount = result.generatedSteps.filter((s) => s.status === "success").length;
                    runData.steps = result.generatedSteps.map(toLeanStep);
                    runData.reasoning = result.reasoning;
                }
                writeCaseResult(
                    dir,
                    { case: testCase.name, generationId: testCase.input.generationId, url: testCase.input.url },
                    runData,
                );
            }
        }

        if (result == null || videoPath == null) {
            expect.fail("Execution produced no result");
        }

        const caseDir = saveCaseArtifacts(RESULTS_DIR, testCase.name, videoPath);
        const savedVideoPath = path.join(caseDir, "recording.webm");

        const agentCost = summarizeRunCost(costCollector);
        const deterministicFailures = checkGenerationResult(result, frontmatter);
        recordInfo({
            finishReason: result.finishReason,
            stepCount: result.generatedSteps.filter((s) => s.status === "success").length,
            steps: result.generatedSteps.map(toLeanStep),
            reasoning: result.reasoning,
            videoPath: savedVideoPath,
            deterministicFailures,
            agentCost,
        });

        if (deterministicFailures.length > 0) {
            const summary = deterministicFailures.map((f) => `${f.check}: ${f.message}`).join("; ");
            writeCaseResult(
                caseDir,
                { case: testCase.name, generationId: testCase.input.generationId, url: testCase.input.url },
                caseData,
            );
            expect.fail(`Deterministic checks failed: ${summary}`);
        }

        if (rubric.trim().length === 0) {
            this.logger.info("No rubric authored, skipping judge", { extra: { case: testCase.name } });
            writeCaseResult(
                caseDir,
                { case: testCase.name, generationId: testCase.input.generationId, url: testCase.input.url },
                caseData,
            );
            return;
        }

        const judgeResult = await this.judge.grade({
            result,
            videoPath: savedVideoPath,
            rawPrompt: input.rawPrompt,
            rubric,
            scenarioData,
        });

        recordInfo({
            judgePassed: judgeResult.passed,
            judgeConfidence: judgeResult.confidence,
            judgeReasoning: judgeResult.reasoning,
            judgeCost: judgeResult.cost,
        });

        writeCaseResult(
            caseDir,
            { case: testCase.name, generationId: testCase.input.generationId, url: testCase.input.url },
            caseData,
        );
        expect(judgeResult.passed, `Judge failed: ${judgeResult.reasoning}`).toBe(true);
    }

    private async provisionScenario(
        input: GenerationEvalInput,
        signingSecret: string | undefined,
        helpers: RunCaseHelpers,
        caseName: string,
    ): Promise<ProvisionedInstance | undefined> {
        const { fixtureJson, sdkUrl } = input;
        if (fixtureJson == null || sdkUrl == null || signingSecret == null) return undefined;

        try {
            return await provisionScenarioInstance({
                fixtureJson,
                sdkUrl,
                signingSecret,
                customHeaders: input.customHeaders,
                applicationId: input.applicationId,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Scenario provisioning failed, skipping case", { extra: { case: caseName, err } });
            helpers.skip(`scenario provisioning failed: ${message}`);
        }
    }
}
