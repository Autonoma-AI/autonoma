import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CostCollector, VisualConditionChecker } from "@autonoma/ai";
import {
    ReplayRunner,
    WaitConditionChecker,
    type ReplayResult,
    type ReplayStep,
    type StepData,
    createEngineModelRegistry,
} from "@autonoma/engine";
import { Evaluation, type LoadedCase, type RunCaseHelpers } from "@autonoma/evals";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger } from "@autonoma/logger";
import { provisionScenarioInstance, teardownScenarioInstance, type ProvisionedInstance } from "@autonoma/scenario";
import { chromium } from "playwright";
import { expect } from "vitest";
import type { WebApplicationData, WebContext } from "../../src/platform";
import { buildWebApplicationData } from "../../src/platform/web-application-data-builder";
import { WebInstaller } from "../../src/platform/web-installer";
import type { ReplayWebCommandSpec } from "../../src/replay/web-command-spec";
import { createWebCommands } from "../../src/replay/web-commands";
import {
    buildScenarioData,
    coerceScenarioVariables,
    resolveSigningSecret,
    saveCaseArtifacts,
    summarizeRunCost,
    writeCaseResult,
} from "../shared/eval-utils";
import { type ReplayEvalFrontmatter, checkReplayResult } from "./replay-frontmatter";
import type { FrozenStep, ReplayEvalInput } from "./replay-input";
import { ReplayJudge } from "./replay-judge";

export type ReplayEvalCase = LoadedCase<ReplayEvalInput, ReplayEvalFrontmatter>;

const CASE_TIMEOUT_MS = 600_000;
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");

setScreenshotConfig({ screenResolution: DEFAULT_VIEWPORT, architecture: "web" });

/**
 * Thin ReplayRunner subclass that exposes seedMemoryEntries publicly so the
 * eval harness can inject credentials without going through the DB-coupled
 * RunAPIRunner path.
 */
class EvalReplayRunner extends ReplayRunner<ReplayWebCommandSpec, WebApplicationData, WebContext> {
    public seedMemoryEntries(entries: Record<string, string>): void {
        for (const [key, value] of Object.entries(entries)) {
            this.memory.set(key, value);
        }
    }
}

export class ReplayEvaluation extends Evaluation<ReplayEvalCase> {
    private readonly logger = rootLogger.child({ name: this.constructor.name });
    private readonly judge = new ReplayJudge();

    constructor(resultsDir: string, cases: ReplayEvalCase[]) {
        super(
            {
                name: "web-replay",
                parallel: false,
                testOptions: { timeout: CASE_TIMEOUT_MS },
                resultsDir,
            },
            cases,
        );
    }

    protected override caseName(testCase: ReplayEvalCase): string {
        const note = testCase.frontmatter.description;
        return note != null ? `${testCase.name} - ${note}` : testCase.name;
    }

    protected override testCaseInfo(testCase: ReplayEvalCase): Record<string, string> {
        const info: Record<string, string> = {
            case: testCase.name,
            applicationId: testCase.input.applicationId,
            url: testCase.input.url,
        };
        if (testCase.input.runId != null) {
            info.runId = testCase.input.runId;
        }
        return info;
    }

    protected override async runCase(
        testCase: ReplayEvalCase,
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
        const installer = new WebInstaller(browser, browserContext);

        let result: ReplayResult<ReplayWebCommandSpec> | undefined;
        let videoPath: string | undefined;
        const costCollector = new CostCollector();

        try {
            const webAppData = await buildWebApplicationData({
                url: input.url,
                file: input.file,
                auth: provisionedInstance?.auth,
                customHeaders: input.customHeaders,
                previewkitBypassToken: input.previewkitBypassToken,
            });

            const models = createEngineModelRegistry(costCollector);
            const commands = createWebCommands(models);

            const runner = new EvalReplayRunner({
                installer,
                commands,
                createWaitChecker: (screen) =>
                    new WaitConditionChecker(
                        new VisualConditionChecker({
                            model: models.getModel({ model: "fast-visual", tag: "wait-condition-checker" }),
                        }),
                        screen,
                    ),
                eventHandlers: {
                    frame: async () => {},
                    beforeStep: async () => {},
                    afterStep: async () => {},
                },
            });

            const credentials = provisionedInstance?.auth?.credentials;
            const resolvedVariables =
                provisionedInstance?.resolvedVariables != null
                    ? coerceScenarioVariables(provisionedInstance.resolvedVariables)
                    : undefined;

            if (credentials != null && Object.keys(credentials).length > 0) {
                runner.seedMemoryEntries(credentials);
            }
            if (resolvedVariables != null && Object.keys(resolvedVariables).length > 0) {
                runner.seedMemoryEntries(resolvedVariables);
            }

            await runner.setup(webAppData);

            const steps = mapToReplaySteps(input.steps);
            const runResult = await runner.run(steps);
            result = runResult.result;
            videoPath = runResult.videoPath;

            this.logger.info("Replay finished", {
                extra: {
                    case: testCase.name,
                    success: result.success,
                    steps: result.state.executedSteps.length,
                },
            });
        } finally {
            try {
                await installer.cleanup();
            } catch (err) {
                this.logger.warn("Browser cleanup failed", { extra: { case: testCase.name, err } });
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
        }

        if (result == null || videoPath == null) {
            expect.fail("Replay produced no result");
        }

        const caseDir = saveCaseArtifacts(RESULTS_DIR, testCase.name, videoPath);
        const savedVideoPath = path.join(caseDir, "recording.webm");

        const replayCost = summarizeRunCost(costCollector);
        const deterministicFailures = checkReplayResult(result, frontmatter);
        recordInfo({
            success: result.success,
            stepCount: result.state.executedSteps.length,
            steps: result.state.executionResults.map(({ step, status, output, error }) => ({
                index: step.index,
                interaction: step.stepData.interaction,
                params: step.stepData.params,
                waitCondition: step.waitCondition,
                status,
                output,
                error: error?.message,
            })),
            reasoning: result.reasoning,
            videoPath: savedVideoPath,
            deterministicFailures,
            replayCost,
        });

        if (deterministicFailures.length > 0) {
            const summary = deterministicFailures.map((f) => `${f.check}: ${f.message}`).join("; ");
            writeCaseResult(
                caseDir,
                { case: testCase.name, runId: testCase.input.runId, url: testCase.input.url },
                caseData,
            );
            expect.fail(`Deterministic checks failed: ${summary}`);
        }

        if (rubric.trim().length === 0) {
            this.logger.info("No rubric authored, skipping judge", { extra: { case: testCase.name } });
            writeCaseResult(
                caseDir,
                { case: testCase.name, runId: testCase.input.runId, url: testCase.input.url },
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
            { case: testCase.name, runId: testCase.input.runId, url: testCase.input.url },
            caseData,
        );
        expect(judgeResult.passed, `Judge failed: ${judgeResult.reasoning}`).toBe(true);
    }

    private async provisionScenario(
        input: ReplayEvalInput,
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

function mapToReplaySteps(frozenSteps: FrozenStep[]): ReplayStep<ReplayWebCommandSpec>[] {
    return frozenSteps.map((step, index) => ({
        index,
        stepData: {
            interaction: step.interaction,
            params: step.params,
        } as StepData<ReplayWebCommandSpec>,
        waitCondition: step.waitCondition,
    }));
}
