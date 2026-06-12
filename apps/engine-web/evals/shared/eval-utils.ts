import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CostCollector } from "@autonoma/ai";
import type { RunCaseHelpers } from "@autonoma/evals";
import type { Logger } from "@autonoma/logger";
import { logger as rootLogger } from "@autonoma/logger";
import { materializeScenarioData, type ProvisionedInstance, type ScenarioData } from "@autonoma/scenario";
import type { ScenarioVariableScalar } from "@autonoma/types";
import { loadSigningSecret } from "../secrets";

/** Minimal input fields required by scenario-related eval helpers. */
interface ScenarioEvalInput {
    applicationId: string;
    scenarioId?: string;
    scenarioName?: string;
}

export function summarizeRunCost(costCollector: CostCollector) {
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

export function coerceScenarioVariables(variables: Record<string, ScenarioVariableScalar>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(variables).map(([key, value]) => [key, value != null ? String(value) : ""]),
    );
}

export function buildScenarioData(
    provisionedInstance: ProvisionedInstance | undefined,
    input: ScenarioEvalInput,
    logger: Logger,
): ScenarioData | undefined {
    if (provisionedInstance == null || input.scenarioId == null) return undefined;
    const name = input.scenarioName ?? input.scenarioId;
    return materializeScenarioData(name, provisionedInstance.createPayload, logger);
}

export function resolveSigningSecret(
    input: ScenarioEvalInput,
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

export function saveCaseArtifacts(resultsDir: string, caseName: string, videoPath: string): string {
    const slug = caseName.slice(0, 48).replace(/[^a-z0-9-]/gi, "-");
    const caseDir = path.join(resultsDir, `${slug}-${Date.now()}`);
    mkdirSync(caseDir, { recursive: true });
    try {
        copyFileSync(videoPath, path.join(caseDir, "recording.webm"));
    } catch (err) {
        rootLogger
            .child({ name: "saveCaseArtifacts" })
            .warn("Failed to copy video", { extra: { videoPath, caseDir, err } });
    }
    return caseDir;
}

export function writeCaseResult(
    caseDir: string,
    metadata: Record<string, unknown>,
    data: Record<string, unknown>,
): void {
    const result = { ...metadata, ...data };
    writeFileSync(path.join(caseDir, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf-8");
}

export function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}
