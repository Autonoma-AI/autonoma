import os from "node:os";
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
import {
    materializeScenarioData,
    provisionScenarioInstance,
    teardownScenarioInstance,
    type ProvisionedInstance,
    type ScenarioData,
} from "@autonoma/scenario";
import type { ScenarioVariableScalar } from "@autonoma/types";
import { chromium } from "playwright";
import { expect } from "vitest";
import type { WebCommandSpec } from "../../src/execution-agent/web-agent";
import { createWebAgentFactory } from "../../src/execution-agent/web-agent";
import type { WebApplicationData, WebContext } from "../../src/platform";
import { buildWebApplicationData } from "../../src/platform/web-application-data-builder";
import { WebInstaller } from "../../src/platform/web-installer";
import { loadSigningSecret } from "../secrets";
import { type GenerationEvalFrontmatter, checkGenerationResult } from "./generation-frontmatter";
import type { GenerationEvalInput } from "./generation-input";
import { GenerationJudge } from "./generation-judge";

export type GenerationEvalCase = LoadedCase<GenerationEvalInput, GenerationEvalFrontmatter>;

const CASE_TIMEOUT_MS = 600_000;
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

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

        let result: ExecutionResult<WebCommandSpec> | undefined;
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
            );
            const runner = new EvalAgentRunner({
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

            const runResult = await runner.run();
            result = runResult.result;
            videoPath = runResult.videoPath;

            this.logger.info("Agent finished", {
                extra: {
                    case: testCase.name,
                    finishReason: result.finishReason,
                    steps: result.generatedSteps.length,
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
            expect.fail("Execution produced no result");
        }

        const agentCost = summarizeRunCost(costCollector);
        const deterministicFailures = checkGenerationResult(result, frontmatter);
        addInfo({
            finishReason: result.finishReason,
            stepCount: result.generatedSteps.filter((s) => s.status === "success").length,
            steps: result.generatedSteps.map(toLeanStep),
            reasoning: result.reasoning,
            videoPath,
            deterministicFailures,
            agentCost,
        });

        if (deterministicFailures.length > 0) {
            const summary = deterministicFailures.map((f) => `${f.check}: ${f.message}`).join("; ");
            expect.fail(`Deterministic checks failed: ${summary}`);
        }

        if (rubric.trim().length === 0) {
            this.logger.info("No rubric authored, skipping judge", { extra: { case: testCase.name } });
            return;
        }

        const judgeResult = await this.judge.grade({
            result,
            videoPath,
            rawPrompt: input.rawPrompt,
            rubric,
            scenarioData,
        });

        addInfo({
            judgePassed: judgeResult.passed,
            judgeConfidence: judgeResult.confidence,
            judgeReasoning: judgeResult.reasoning,
            judgeCost: judgeResult.cost,
        });

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

function summarizeRunCost(costCollector: CostCollector) {
    return costCollector.getRecords().reduce(
        (acc, record) => ({
            callCount: acc.callCount + 1,
            costMicrodollars: acc.costMicrodollars + record.costMicrodollars,
            inputTokens: acc.inputTokens + record.inputTokens,
            outputTokens: acc.outputTokens + record.outputTokens,
        }),
        { callCount: 0, costMicrodollars: 0, inputTokens: 0, outputTokens: 0 },
    );
}

function coerceScenarioVariables(variables: Record<string, ScenarioVariableScalar>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(variables).map(([key, value]) => [key, value != null ? String(value) : ""]),
    );
}

function buildScenarioData(
    provisionedInstance: ProvisionedInstance | undefined,
    input: GenerationEvalInput,
    logger: ReturnType<typeof rootLogger.child>,
): ScenarioData | undefined {
    if (provisionedInstance == null || input.scenarioId == null) return undefined;
    const name = input.scenarioName ?? input.scenarioId;
    return materializeScenarioData(name, provisionedInstance.createPayload, logger);
}

function resolveSigningSecret(
    input: GenerationEvalInput,
    helpers: RunCaseHelpers,
    caseName: string,
): string | undefined {
    if (input.scenarioId == null) return undefined;

    try {
        return loadSigningSecret(input.applicationId);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        rootLogger
            .child({ name: "resolveSigningSecret" })
            .warn("No signing secret found, skipping case", { extra: { case: caseName, err } });
        helpers.skip(`signing secret missing: ${message}`);
    }
}
