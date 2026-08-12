import type { PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { artifactEventWhere } from "../app-generations/artifact-file-events";
import { areArtifactsComplete } from "../app-generations/artifacts-complete";

/**
 * The four independent signals the Finish setup gate is derived from, plus the gate itself.
 *
 * Read by both `onboarding.navState` (which needs only `setupComplete`) and `onboarding.getState`
 * (which surfaces every signal as a checklist), so the gate is defined in exactly one place.
 */
export interface SetupState {
    sdkConfigured: boolean;
    dryRunPassed: boolean;
    artifactsUploaded: boolean;
    hasContent: boolean;
    setupComplete: boolean;
}

/**
 * Whether an application has finished Finish setup, in one wave of existence probes and no writes.
 *
 * Two independent routes reach completion. The first is the real flow: the SDK discovered, every
 * artifact landed, and every provisionable scenario tore down cleanly at least once. The second is
 * a compatibility path for applications whose content arrived without a completed planner run -
 * they have scenarios and tests, so there is nothing left to ask them for.
 *
 * Deliberately derived rather than stored: `dryRunPassed`'s input is written by every real
 * pull-request test-run teardown (not just the onboarding dry run), and the predicate is not
 * monotonic - `artifactsUploaded` turning true can withdraw completion granted by the
 * compatibility route. A persisted copy would need a writer hook in five packages and would still
 * drift.
 */
export async function computeSetupState(db: PrismaClient, applicationId: string, logger: Logger): Promise<SetupState> {
    const [row, scenarios, testCase, validatedInstances, completedSetup, kbEvent, scenariosEvent, testEvent] =
        await Promise.all([
            db.onboardingState.findUnique({ where: { applicationId }, select: { lastDiscoveredAt: true } }),
            // One read answers all three scenario questions below: any scenario at all, any with an
            // active recipe, and the stricter provisionable set. An application has a handful.
            db.scenario.findMany({
                where: { applicationId },
                select: { id: true, isDisabled: true, activeRecipeVersionId: true },
            }),
            // Ignore investigation shadow cases - they are validation probes, not real onboarding content.
            db.testCase.findFirst({ where: { applicationId, shadow: false }, select: { id: true } }),
            db.scenarioInstance.findMany({
                where: { applicationId, status: "DOWN_SUCCESS" },
                select: { scenarioId: true },
                distinct: ["scenarioId"],
            }),
            db.applicationSetup.findFirst({ where: { applicationId, status: "completed" }, select: { id: true } }),
            db.applicationSetupEvent.findFirst({
                where: artifactEventWhere(applicationId, "kb"),
                select: { id: true },
            }),
            db.applicationSetupEvent.findFirst({
                where: artifactEventWhere(applicationId, "scenarios"),
                select: { id: true },
            }),
            // Existence, not a count: the checklist needs "3 files", the gate only needs "any". Probing
            // stops at the first row instead of pulling every matching event's JSON payload back to
            // dedupe paths in memory - the same question, asked the cheap way.
            db.applicationSetupEvent.findFirst({
                where: artifactEventWhere(applicationId, "tests"),
                select: { id: true },
            }),
        ]);

    const provisionable = scenarios.filter(
        (scenario) => !scenario.isDisabled && scenario.activeRecipeVersionId != null,
    );
    const validatedScenarioIds = new Set(validatedInstances.map((instance) => instance.scenarioId));

    const sdkConfigured = row?.lastDiscoveredAt != null;
    const dryRunPassed =
        provisionable.length > 0 && provisionable.every((candidate) => validatedScenarioIds.has(candidate.id));
    const artifactsUploaded = areArtifactsComplete({
        setupCompleted: completedSetup != null,
        hasRecipe: scenarios.some((scenario) => scenario.activeRecipeVersionId != null),
        hasTests: testEvent != null,
        hasKb: kbEvent != null,
        hasScenarios: scenariosEvent != null,
    });
    const hasContent = scenarios.length > 0 && testCase != null;

    const completedTheRealFlow = sdkConfigured && dryRunPassed && artifactsUploaded;
    const arrivedWithContentAlready = hasContent && !artifactsUploaded;
    const setupComplete = completedTheRealFlow || arrivedWithContentAlready;

    logger.info("Computed onboarding setup state", {
        application: { applicationId },
        extra: { sdkConfigured, dryRunPassed, artifactsUploaded, hasContent, setupComplete },
    });

    return { sdkConfigured, dryRunPassed, artifactsUploaded, hasContent, setupComplete };
}
