import { db } from "@autonoma/db";
import {
    LocalCodebaseReader,
    PreviewEnvironment,
    PreviewSecrets,
    ScenarioRecipe,
    TestCatalog,
    type DryRunSeed,
    repairRecipeWithAgent,
} from "@autonoma/investigation";
import { logger as rootLogger } from "@autonoma/logger";
import {
    EncryptionHelper,
    provisionScenarioInstance,
    resolveSdkConfig,
    teardownScenarioInstance,
} from "@autonoma/scenario";
import { ScenarioRecipeSchema } from "@autonoma/types";
import type { ProposeRecipeRepairInput, ProposeRecipeRepairOutput } from "@autonoma/workflow/activities";
import { resolvePrMeta } from "../codebase/pr-meta";
import { withSnapshotContext } from "../codebase/resolve";
import { env } from "../env";
import { createModelSession } from "../services";

/** Cap on the sanitized factory-error length that reaches the model / handoff / client PR comment. */
const MAX_FACTORY_ERROR_CHARS = 300;

/**
 * Run the recipe-repair AGENT for one scenario failure (autofix orgs only - the workflow gates this behind the
 * org's autofix flag). Unlike the diagnoser's one-shot proposal, this clones the client repo and gives the agent
 * tools: it reads the factory/seeding code + DB schema, queries the LIVE preview backend to see what data already
 * exists, validates candidate graphs locally, and - when the SDK key is wired - dry-run-seeds each candidate
 * against the real factory before returning one. It returns a route + an optional VALIDATED candidate graph (which
 * the workflow then stages on the twin, the authoritative rerun gate) or a handoff when it gives up. Analysis +
 * dry-runs only; it never writes a recipe. Contained by the caller: any throw is logged and surfaces as no repair.
 */
export async function proposeRecipeRepair(input: ProposeRecipeRepairInput): Promise<ProposeRecipeRepairOutput> {
    const { snapshotId, slug, recipeChange, failureDetail, priorAttempts } = input;
    const logger = rootLogger.child({ name: "proposeRecipeRepair", extra: { snapshotId, slug } });
    logger.info("Proposing a recipe repair with the agent", { extra: { priorAttempts: priorAttempts?.length ?? 0 } });

    const catalog = new TestCatalog(db);
    const resolved = await catalog.resolveSnapshotPlan(snapshotId, slug);
    const scenarioId = resolved?.scenarioId;
    if (scenarioId == null) {
        logger.info("No bound scenario for this test; nothing to repair");
        return { route: "unknown", confidence: "low", reasoning: "no bound scenario", dryRunAvailable: false };
    }

    const currentCreateGraph = await new ScenarioRecipe(db).getCreateGraph(scenarioId, snapshotId);
    if (currentCreateGraph == null) {
        logger.info("No recipe version for this scenario/snapshot; nothing to repair");
        return { route: "unknown", confidence: "low", reasoning: "no recipe version", dryRunAvailable: false };
    }

    const testPlan = (await catalog.getSnapshotPlan(snapshotId, slug)) ?? "";

    return withSnapshotContext(snapshotId, `repair-${slug}`, async (context) => {
        const prMeta = await resolvePrMeta(context);
        const reader = new LocalCodebaseReader(context.codebase.root, context.baseSha, context.headSha);
        const preview = new PreviewEnvironment(PreviewSecrets.create(), context.repoFullName);
        const model = createModelSession().getModel({ model: "classifier", tag: "investigation-repair" });

        const dryRunSeed = await buildDryRunSeed({ snapshotId, scenarioId, applicationId: context.applicationId });

        const result = await repairRecipeWithAgent(
            {
                appSlug: context.appSlug,
                prNumber: prMeta.prNumber,
                slug,
                currentCreateGraph,
                recipeChange,
                failureDetail,
                testPlan,
                priorAttempts,
            },
            { codebase: reader, preview, dryRunSeed, model, maxSteps: env.INVESTIGATION_REPAIR_MAX_STEPS },
        );

        logger.info("Recipe repair proposed", {
            extra: { route: result.route, hasCandidate: result.createGraphJson != null, dryRun: dryRunSeed != null },
        });
        return {
            route: result.route,
            confidence: result.confidence,
            reasoning: result.reasoning,
            createGraphJson: result.createGraphJson,
            summary: result.summary,
            factoryIssue: result.factoryIssue,
            handoff: result.handoff,
            dryRunAvailable: dryRunSeed != null,
        };
    });
}

/**
 * Wire the dry_run_seed capability: seed a candidate `create` graph against the client's LIVE factory (`up`),
 * then tear it down - the authoritative check that the factory accepts the data, short of running the test.
 * Returns undefined when the SDK signing-secret key is not configured on this worker (the agent then degrades to
 * schema + backend-query checks). The full recipe is loaded so template variables resolve exactly as production
 * does (an unresolved `{{admin_email}}` is what makes a raw `up` 500) - only the `create` graph is swapped.
 */
async function buildDryRunSeed(params: {
    snapshotId: string;
    scenarioId: string;
    applicationId: string;
}): Promise<DryRunSeed | undefined> {
    const { snapshotId, scenarioId, applicationId } = params;
    const logger = rootLogger.child({ name: "buildDryRunSeed", extra: { snapshotId, scenarioId } });

    const encryptionKey = env.SCENARIO_ENCRYPTION_KEY;
    if (encryptionKey == null) {
        logger.info("SCENARIO_ENCRYPTION_KEY not configured; dry_run_seed disabled (agent uses schema + queries)");
        return undefined;
    }

    const deploymentId = await resolveDeploymentId(snapshotId);
    if (deploymentId == null) {
        logger.info("Snapshot has no branch deployment; dry_run_seed disabled");
        return undefined;
    }

    const version = await db.scenarioRecipeVersion.findUnique({
        where: { scenarioId_snapshotId: { scenarioId, snapshotId } },
        select: { fixtureJson: true },
    });
    if (version == null) {
        logger.info("No recipe version to seed against; dry_run_seed disabled");
        return undefined;
    }
    const baseRecipe = ScenarioRecipeSchema.parse(version.fixtureJson);

    const sdkConfig = await resolveSdkConfig({
        applicationId,
        deploymentId,
        db,
        encryption: new EncryptionHelper(encryptionKey),
    });

    return async (createGraphJson) => {
        // Swap only the candidate `create` graph into the real recipe; re-validate the whole fixture so a
        // malformed candidate is caught here rather than surfacing as an opaque SDK error.
        const fixtureJson = ScenarioRecipeSchema.parse({ ...baseRecipe, create: JSON.parse(createGraphJson) });

        let instance: Awaited<ReturnType<typeof provisionScenarioInstance>> | undefined;
        try {
            instance = await provisionScenarioInstance({
                fixtureJson,
                sdkUrl: sdkConfig.sdkUrl,
                signingSecret: sdkConfig.signingSecret,
                customHeaders: sdkConfig.customHeaders,
                applicationId,
            });
            return { ok: true, detail: describeSeed(instance.refs, instance.auth != null) };
        } catch (error) {
            // The raw provisioning error can carry internal URLs / deployment ids / stack detail. The agent may
            // fold this into its handoff, which is rendered into the report AND the client PR comment - so strip
            // the infrastructure specifics before it reaches the model, keeping only the factory's own message.
            return { ok: false, detail: sanitizeFactoryError(error) };
        } finally {
            if (instance != null) {
                const provisioned = instance;
                await teardownScenarioInstance({
                    instanceId: provisioned.instanceId,
                    sdkUrl: sdkConfig.sdkUrl,
                    signingSecret: sdkConfig.signingSecret,
                    customHeaders: sdkConfig.customHeaders,
                    refs: provisioned.refs,
                    refsToken: provisioned.refsToken,
                    applicationId,
                }).catch((error) => {
                    logger.warn("Dry-run teardown failed; the instance may linger until its TTL", { err: error });
                });
            }
        }
    };
}

/** The branch deployment the snapshot points at, mirroring how the scenario subjects resolve it for `up`. */
async function resolveDeploymentId(snapshotId: string): Promise<string | undefined> {
    const snapshot = await db.branchSnapshot.findUnique({
        where: { id: snapshotId },
        select: { branch: { select: { deployment: { select: { id: true } } } } },
    });
    return snapshot?.branch.deployment?.id ?? undefined;
}

/**
 * Reduce a raw provisioning error to just the factory's own message: strip URLs, UUIDs, and long hex/token runs
 * (internal endpoints, deployment ids, signatures) and cap the length. This is a defense-in-depth redaction - the
 * result reaches the model, its handoff, and the client-facing PR comment, so it must not carry our infrastructure
 * specifics. It keeps the actionable part ("missing required field X", "unknown model Y").
 */
function sanitizeFactoryError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const redacted = raw
        .replace(/https?:\/\/\S+/gi, "[url]")
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
        .replace(/\b[0-9a-f]{16,}\b/gi, "[token]")
        .trim();
    return redacted.length > MAX_FACTORY_ERROR_CHARS ? `${redacted.slice(0, MAX_FACTORY_ERROR_CHARS)}...` : redacted;
}

/** Per-entity seeded counts + whether auth came back - never dumps ids or secret values. */
function describeSeed(refs: Record<string, unknown> | undefined, hasAuth: boolean): string {
    const parts: string[] = [];
    if (refs != null) {
        for (const [key, value] of Object.entries(refs)) {
            if (Array.isArray(value)) parts.push(`${key}=${value.length}`);
            else if (value != null) parts.push(key);
        }
    }
    const seeded = parts.length > 0 ? `seeded ${parts.join(", ")}` : "seeded (no ref counts reported)";
    return `factory accepted the graph; ${seeded}; auth ${hasAuth ? "returned" : "NOT returned (a scenario gap)"}.`;
}
