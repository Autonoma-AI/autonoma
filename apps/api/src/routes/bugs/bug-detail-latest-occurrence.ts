import type { PrismaClient } from "@autonoma/db";
import type { StorageProvider } from "@autonoma/storage";
import { runAnalysisSchema, stepOutputDataSchema } from "@autonoma/types";
import { findFailureStep } from "../find-failure-step";
import type { BugLatestOccurrenceIssueRow } from "./bugs.service";

type ScreenshotTiming = "before" | "after";

export async function buildLatestOccurrenceEvidence(
    db: PrismaClient,
    issue: BugLatestOccurrenceIssueRow | null,
    storageProvider: StorageProvider,
) {
    if (issue == null) return undefined;
    const source = buildOccurrenceSource(issue);
    if (source == null) return undefined;

    const parsedAnalysis = runAnalysisSchema.safeParse(source.analysis);
    const analysis = parsedAnalysis.success ? parsedAnalysis.data : undefined;
    const outputs = source.outputs;
    const failureStep = findFailureStep(outputs, analysis?.failurePoint?.stepOrder);
    const failureOutput = stepOutputDataSchema.safeParse(failureStep?.output);
    const failureOutputData = failureOutput.success ? failureOutput.data : undefined;
    const failureScreenshot = selectFailureScreenshot(failureStep, source.fallbackScreenshotKey);
    const lastPassingScreenshotKey =
        failureScreenshot?.stepOrder != null && failureScreenshot.timing != null
            ? await findLastPassingScreenshotKey(db, {
                  testCaseId: source.testCaseId,
                  before: source.createdAt,
                  stepOrder: failureScreenshot.stepOrder,
                  timing: failureScreenshot.timing,
              })
            : undefined;
    const videoEvidence = analysis?.evidence.find((item) => item.type === "video" && item.s3Key != null);

    const [lastPassingScreenshotUrl, failureScreenshotUrl, videoUrl] = await Promise.all([
        lastPassingScreenshotKey != null ? storageProvider.getSignedUrl(lastPassingScreenshotKey, 3600) : undefined,
        failureScreenshot?.key != null ? storageProvider.getSignedUrl(failureScreenshot.key, 3600) : undefined,
        videoEvidence?.s3Key != null
            ? storageProvider.getSignedUrl(videoEvidence.s3Key, 3600)
            : source.fallbackVideoKey != null
              ? storageProvider.getSignedUrl(source.fallbackVideoKey, 3600)
              : undefined,
    ]);

    const reproductionSteps = await Promise.all(
        outputs.map(async (step) => {
            const parsedOutput = stepOutputDataSchema.safeParse(step.output);
            const outcome = parsedOutput.success ? parsedOutput.data.outcome : undefined;
            const [screenshotBeforeUrl, screenshotAfterUrl] = await Promise.all([
                step.screenshotBefore != null ? storageProvider.getSignedUrl(step.screenshotBefore, 3600) : undefined,
                step.screenshotAfter != null ? storageProvider.getSignedUrl(step.screenshotAfter, 3600) : undefined,
            ]);
            return {
                order: step.order,
                interaction: step.stepInput.interaction,
                params: step.stepInput.params,
                outcome,
                isFailing: failureStep != null && step.order === failureStep.order,
                screenshotBeforeUrl,
                screenshotAfterUrl,
            };
        }),
    );

    return {
        issueId: issue.id,
        source: source.kind,
        sourceId: source.id,
        runId: source.kind === "run" ? source.id : undefined,
        generationId: source.kind === "generation" ? source.id : undefined,
        testSlug: source.testSlug,
        stepIndex: failureStep?.order,
        stepCount: outputs.length,
        actionLabel:
            failureStep != null
                ? formatActionLabel(failureStep.stepInput.interaction, failureStep.stepInput.params)
                : undefined,
        outcomeLabel: failureOutputData?.outcome,
        whatHappened: analysis?.failurePoint?.description ?? source.reasoning ?? undefined,
        lastPassingScreenshotUrl,
        failureScreenshotUrl,
        point: failureOutputData?.point,
        startPoint: failureOutputData?.startPoint,
        endPoint: failureOutputData?.endPoint,
        reproductionSteps,
        videoUrl,
    };
}

function buildOccurrenceSource(issue: BugLatestOccurrenceIssueRow | null) {
    const runReview = issue?.runReview;
    const run = runReview?.run;
    if (issue != null && runReview != null && run != null) {
        return {
            kind: "run" as const,
            id: run.id,
            createdAt: run.createdAt,
            testCaseId: run.assignment.testCase.id,
            testSlug: run.assignment.testCase.slug,
            analysis: runReview.analysis,
            reasoning: runReview.reasoning,
            outputs: run.outputs?.list ?? [],
            fallbackScreenshotKey: undefined,
            fallbackVideoKey: `run/${run.id}/video.webm`,
        };
    }

    const generationReview = issue?.generationReview;
    const generation = generationReview?.generation;
    if (issue != null && generationReview != null && generation != null) {
        return {
            kind: "generation" as const,
            id: generation.id,
            createdAt: generation.createdAt,
            testCaseId: generation.testPlan.testCase.id,
            testSlug: generation.testPlan.testCase.slug,
            analysis: generationReview.analysis,
            reasoning: generationReview.reasoning,
            outputs: generation.outputs?.list ?? [],
            fallbackScreenshotKey: generation.finalScreenshot ?? undefined,
            fallbackVideoKey: generation.videoUrl ?? undefined,
        };
    }

    return undefined;
}

function selectFailureScreenshot(
    failureStep:
        | {
              order: number;
              screenshotBefore: string | null;
              screenshotAfter: string | null;
          }
        | undefined,
    fallbackScreenshotKey: string | undefined,
): { key: string; stepOrder?: number; timing?: ScreenshotTiming } | undefined {
    if (failureStep?.screenshotAfter != null) {
        return { key: failureStep.screenshotAfter, stepOrder: failureStep.order, timing: "after" };
    }
    if (failureStep?.screenshotBefore != null) {
        return { key: failureStep.screenshotBefore, stepOrder: failureStep.order, timing: "before" };
    }
    return fallbackScreenshotKey != null ? { key: fallbackScreenshotKey } : undefined;
}

async function findLastPassingScreenshotKey(
    db: PrismaClient,
    {
        testCaseId,
        before,
        stepOrder,
        timing,
    }: {
        testCaseId: string;
        before: Date;
        stepOrder: number;
        timing: ScreenshotTiming;
    },
): Promise<string | undefined> {
    const lastPassingRun = await db.run.findFirst({
        where: {
            status: "success",
            createdAt: { lt: before },
            assignment: { testCaseId },
        },
        orderBy: { createdAt: "desc" },
        select: {
            outputs: {
                select: {
                    list: {
                        where: { order: stepOrder },
                        select: { screenshotBefore: true, screenshotAfter: true },
                        take: 1,
                    },
                },
            },
        },
    });

    const matchingStep = lastPassingRun?.outputs?.list[0];
    return timing === "after"
        ? (matchingStep?.screenshotAfter ?? undefined)
        : (matchingStep?.screenshotBefore ?? undefined);
}

function formatActionLabel(interaction: string, params: unknown): string {
    const description = paramDescription(params);
    return description == null ? `agent.${interaction}()` : `agent.${interaction}("${description}")`;
}

function paramDescription(params: unknown): string | undefined {
    if (typeof params !== "object" || params == null || Array.isArray(params) || !("description" in params)) {
        return undefined;
    }
    return typeof params.description === "string" && params.description.length > 0 ? params.description : undefined;
}
