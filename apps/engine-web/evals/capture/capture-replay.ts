import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { EncryptionHelper, SdkClient, provisionScenarioInstance, teardownScenarioInstance } from "@autonoma/scenario";
import { ScenarioRecipeSchema } from "@autonoma/types";
import { z } from "zod";
import { resolvePreviewkitBypassToken } from "../../src/platform/previewkit-bypass-token";
import { env } from "../env";
import type { GenerationEvalInput } from "../generation/generation-input";
import { frozenStepSchema, type FrozenStep, type ReplayEvalInput } from "../replay/replay-input";
import { writeSigningSecret } from "../secrets";
import { slugify } from "../shared/eval-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, "../replay/cases");

export interface CaptureReplayParams {
    runId: string;
    /** Case folder name (defaults to slugified test case name). */
    name?: string;
    /** Overwrite an existing case folder. */
    force?: boolean;
    /** Run a full provisionScenarioInstance up + down dry-run before writing. */
    validate?: boolean;
    /** Override the app URL (replaces webDeployment.url from the database). */
    url?: string;
    /** Override the SDK/scenario webhook URL (replaces deployment.webhookUrl from the database). */
    sdkUrl?: string;
}

/**
 * Capture a live Run from the database and freeze it as a replay eval case.
 *
 * Reads Run + TestCaseAssignment + StepInputList + TestPlan + Application +
 * WebDeployment + BranchSnapshot + ScenarioRecipeVersion from the database.
 * Freezes the assembled input to `input.json` (rawPrompt, url, applicationId,
 * sdkUrl, unresolved fixtureJson, recorded steps). Writes the decrypted signing
 * secret to the gitignored `.secrets.json`. Scaffolds a blank `expected.md`.
 *
 * Warns if the snapshot branch is not main. Refuses if no recipe exists for the
 * (scenarioId, snapshotId) pair.
 */
export async function captureReplay(params: CaptureReplayParams): Promise<string> {
    const logger = rootLogger.child({ name: "captureReplay" });
    const { runId, force = false, validate = false } = params;
    const urlOverride = params.url;
    const sdkUrlOverride = params.sdkUrl;

    logger.info("Capturing replay eval case", { extra: { runId } });
    if (urlOverride != null) logger.info("URL override active", { extra: { urlOverride } });
    if (sdkUrlOverride != null) logger.info("SDK URL override active", { extra: { sdkUrlOverride } });

    const run = await db.run.findUnique({
        where: { id: runId },
        include: {
            plan: {
                include: {
                    scenario: true,
                    testCase: {
                        include: { application: true },
                    },
                },
            },
            assignment: {
                include: {
                    steps: {
                        include: {
                            list: { orderBy: { order: "asc" } },
                        },
                    },
                    snapshot: {
                        include: {
                            branch: {
                                include: {
                                    deployment: {
                                        include: { webDeployment: true },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    });

    if (run == null) {
        throw new Error(`Run ${runId} not found`);
    }

    const { plan, assignment } = run;

    if (plan == null) {
        throw new Error(`Run ${runId} has no associated TestPlan (planId is null)`);
    }

    const { testCase, scenario } = plan;
    const { application } = testCase;

    if (assignment.steps == null) {
        throw new Error(`Run ${runId} has no StepInputList - the run may not have been executed yet`);
    }

    const branch = assignment.snapshot.branch;
    const deployment = branch.deployment;
    const webDeployment = deployment?.webDeployment;

    if (webDeployment == null || deployment == null) {
        throw new Error(`Run ${runId} has no web deployment on snapshot ${assignment.snapshotId}`);
    }

    if (branch.name !== "main" && branch.name !== "master") {
        logger.warn("Snapshot branch is not main - eval cases should point at stable main-branch deployments", {
            extra: { branch: branch.name, runId },
        });
    }

    const frozenSteps: FrozenStep[] = assignment.steps.list.map((step) =>
        frozenStepSchema.parse({
            interaction: step.interaction,
            params: step.params,
            waitCondition: step.waitCondition ?? undefined,
        }),
    );

    if (frozenSteps.length === 0) {
        throw new Error(`Run ${runId} has no steps to freeze`);
    }

    let sdkUrl: string | undefined;
    let customHeaders: Record<string, string> | undefined;
    let fixtureJson: GenerationEvalInput["fixtureJson"];
    let signingSecret: string | undefined;

    if (scenario != null) {
        const recipeVersion = await db.scenarioRecipeVersion.findFirst({
            where: { scenarioId: scenario.id, snapshotId: assignment.snapshotId },
            orderBy: { createdAt: "desc" },
        });

        if (recipeVersion == null) {
            throw new Error(
                `No ScenarioRecipeVersion found for scenario ${scenario.id} + snapshot ${assignment.snapshotId}. ` +
                    "Capture requires a frozen recipe. Run this on a snapshot that has one.",
            );
        }

        fixtureJson = ScenarioRecipeSchema.parse(recipeVersion.fixtureJson);
        sdkUrl = sdkUrlOverride ?? deployment.webhookUrl ?? undefined;
        customHeaders = z.record(z.string(), z.string()).optional().catch(undefined).parse(deployment.webhookHeaders);

        if (application.signingSecretEnc != null) {
            const encryptionKey = env.SCENARIO_ENCRYPTION_KEY;
            if (encryptionKey == null) {
                throw new Error(
                    "SCENARIO_ENCRYPTION_KEY is not set. Set it in your .env to decrypt the application signing secret.",
                );
            }
            signingSecret = new EncryptionHelper(encryptionKey).decrypt(application.signingSecretEnc);
        }
    }

    if (sdkUrl != null && signingSecret != null) {
        logger.info("Checking SDK endpoint liveness (discover)");
        const client = new SdkClient({
            applicationId: application.id,
            sdkUrl,
            signingSecret,
            customHeaders,
        });
        await client.discover();
        logger.info("SDK endpoint is live");
    }

    if (validate && fixtureJson != null && sdkUrl != null && signingSecret != null) {
        logger.info("Running scenario up/down dry-run (--validate)");
        const instance = await provisionScenarioInstance({
            fixtureJson,
            sdkUrl,
            signingSecret,
            customHeaders,
            applicationId: application.id,
        });
        await teardownScenarioInstance({
            instanceId: instance.instanceId,
            sdkUrl,
            signingSecret,
            customHeaders,
            refs: instance.refs,
            refsToken: instance.refsToken,
            applicationId: application.id,
        });
        logger.info("Scenario dry-run passed");
    }

    const caseName = params.name ?? slugify(testCase.name);
    const caseDir = path.join(CASES_DIR, caseName);

    if (existsSync(caseDir) && !force) {
        throw new Error(`Case folder already exists: ${caseDir} (pass --force to overwrite)`);
    }

    const appUrl = urlOverride ?? webDeployment.url;
    const previewkitBypassToken = await resolvePreviewkitBypassToken(appUrl);
    if (previewkitBypassToken != null) {
        logger.info("Resolved previewkit bypass token for URL", { extra: { url: appUrl } });
    }

    const input: ReplayEvalInput = {
        runId: run.id,
        rawPrompt: plan.prompt,
        customInstructions: application.customInstructions ?? undefined,
        url: appUrl,
        file: webDeployment.file,
        applicationId: application.id,
        sdkUrl,
        customHeaders,
        scenarioId: scenario?.id,
        scenarioName: scenario?.name ?? undefined,
        fixtureJson,
        previewkitBypassToken,
        steps: frozenSteps,
    };

    mkdirSync(caseDir, { recursive: true });
    writeFileSync(path.join(caseDir, "input.json"), `${JSON.stringify(input, null, 2)}\n`, "utf-8");

    if (signingSecret != null) {
        writeSigningSecret(application.id, signingSecret);
        logger.info("Signing secret written to .secrets.json", { extra: { applicationId: application.id } });
    }

    writeFileSync(path.join(caseDir, "expected.md"), blankExpected(testCase.name, frozenSteps.length), "utf-8");

    logger.info("Captured replay eval case", {
        extra: { caseDir, stepCount: frozenSteps.length, scenarioId: scenario?.id },
    });
    return caseDir;
}

function blankExpected(testCaseName: string, stepCount: number): string {
    return `---
description: "${testCaseName}"
stepCount: ${stepCount}
---
`;
}

async function main(): Promise<void> {
    const logger = rootLogger.child({ name: "capture-replay-cli" });

    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            name: { type: "string" },
            force: { type: "boolean", default: false },
            validate: { type: "boolean", default: false },
            url: { type: "string" },
            "sdk-url": { type: "string" },
        },
    });

    const [runId] = positionals;
    if (runId == null) {
        throw new Error(
            "Missing <runId>. Usage: capture-replay.ts <runId> [--name <case-name>] [--force] [--validate] [--url <app-url>] [--sdk-url <webhook-url>]",
        );
    }

    const capParams: CaptureReplayParams = { runId, force: values.force, validate: values.validate };
    if (values.name != null) capParams.name = values.name;
    if (values.url != null) capParams.url = values.url;
    if (values["sdk-url"] != null) capParams.sdkUrl = values["sdk-url"];

    const caseDir = await captureReplay(capParams);
    logger.info("Capture complete", { extra: { caseDir } });
    process.stdout.write(`Captured replay eval case to ${caseDir}\n`);
}

try {
    await main();
} catch (err) {
    console.error(err);
    rootLogger
        .child({ name: "capture-replay-cli" })
        .error("Capture failed", err instanceof Error ? err : new Error(String(err)));
    process.exitCode = 1;
}
