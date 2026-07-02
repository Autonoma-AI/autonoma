import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { planSummary } from "../plan-summary";

/**
 * One edit the branch's investigation proposed, derived by diffing the twin snapshot against its fork-point
 * baseline (`prevSnapshotId`). A `new_test` is a test case assigned to the twin but not the baseline; a
 * `modification` is a test case on both whose pinned plan the branch repointed.
 */
export interface BranchEdit {
    kind: "new_test" | "modification";
    /** The existing test's slug (modification) or the proposed test's name (new_test) - the decision key. */
    ref: string;
    /** The test case's display name. */
    name: string;
    /** The flow (folder) the test lives in. */
    flow: string;
    /** A one-line summary from the proposed plan's frontmatter. */
    description: string;
    /** The full plan the branch proposes (the new test's plan, or the modification's revised plan). */
    proposedPlan: string;
    /** The fork-point plan the branch started from (modifications only) - the "base" side of the 3-way view. */
    basePlan?: string;
    /**
     * Main's CURRENT plan for this slug, if the same test still exists on main (modifications only). When this
     * differs from `basePlan`, others merged a change to the same test and the reconciler must adapt.
     */
    mainCurrentPlan?: string;
}

/** One test in main's current suite, as a summary line (full plans are only carried for the edits themselves). */
export interface MainSuiteEntry {
    slug: string;
    name: string;
    flow: string;
    description: string;
}

/**
 * One scenario-recipe edit the branch's investigation proposed, derived by diffing the twin's recipe `create`
 * graph against its fork-point baseline (`prevSnapshotId`). Only the `create` graph is reconciled - the rest of
 * the recipe (name/description/variables/validation) is preserved when applied. A recipe fix that was correct
 * for the branch is correct for main once the PR merges (the code is now main's), which is why merge is the safe
 * moment to carry it; the 3-way view catches the case where main's recipe drifted independently since the fork.
 */
export interface RecipeMergeEdit {
    scenarioId: string;
    /** The scenario's name (for the reconcile reason + report). */
    scenarioName: string;
    /** The branch's proposed `create` graph (JSON string) - the "proposed" side of the 3-way view. */
    proposedCreateGraph: string;
    /** The fork-point `create` graph the branch started from - the "base" side. */
    baseCreateGraph: string;
    /** Main's CURRENT `create` graph for this scenario, if it still has a recipe. Diverges from base = others changed it. */
    mainCreateGraph?: string;
}

export interface MergeInputs {
    edits: BranchEdit[];
    mainSuite: MainSuiteEntry[];
    recipeEdits: RecipeMergeEdit[];
}

interface RecipeRow {
    scenarioId: string;
    name: string;
    /** The recipe's `create` graph, serialized (JSON string) for comparison + the reconcile prompt. */
    createGraph: string;
}

interface AssignmentRow {
    testCaseId: string;
    planId: string | null;
    slug: string;
    name: string;
    flow: string;
    /** The test case's persisted description (the falsifiable behavioral claim), carried through on merge. */
    description: string | undefined;
    prompt: string | undefined;
}

/**
 * Reads the two sides of a merge-with-main reconciliation: the branch's investigation edits (the twin
 * snapshot's delta versus its fork-point baseline) and main's current suite. All reads are scoped to the
 * organization. Produces plain data for the reconciler - no AI, no mutation.
 */
export class MergeInputsReader {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Derive the branch edits from `twinSnapshotId` (against its `prevSnapshotId` baseline) and pair them with
     * main's current suite (`mainSnapshotId`). Modifications are enriched with main's current plan for the same
     * slug so the reconciler sees a 3-way view (base, branch-proposed, main-current).
     */
    async read(twinSnapshotId: string, mainSnapshotId: string, organizationId: string): Promise<MergeInputs> {
        this.logger.info("Reading merge inputs", {
            snapshot: { snapshotId: twinSnapshotId },
            extra: { mainSnapshotId },
        });

        const twin = await this.db.branchSnapshot.findUnique({
            where: { id: twinSnapshotId, branch: { organizationId } },
            select: { prevSnapshotId: true },
        });
        if (twin == null) throw new Error(`Twin snapshot ${twinSnapshotId} not found for organization`);

        // The twin's own assignments, main's suite, the fork-point baseline, and all three sides' recipe graphs
        // are independent reads - load them in one parallel wave (the baseline needs the twin's prevSnapshotId,
        // resolved just above). Recipes on the baseline/main may be absent, which the diff handles.
        const baselineSnapshotId = twin.prevSnapshotId;
        const [twinAssignments, mainAssignments, baselineByTestCase, twinRecipes, baselineRecipes, mainRecipes] =
            await Promise.all([
                this.loadAssignments(twinSnapshotId),
                this.loadAssignments(mainSnapshotId),
                baselineSnapshotId != null
                    ? this.loadAssignmentsByTestCase(baselineSnapshotId)
                    : Promise.resolve(new Map<string, AssignmentRow>()),
                this.loadRecipesByScenario(twinSnapshotId),
                baselineSnapshotId != null
                    ? this.loadRecipesByScenario(baselineSnapshotId)
                    : Promise.resolve(new Map<string, RecipeRow>()),
                this.loadRecipesByScenario(mainSnapshotId),
            ]);
        const mainBySlug = new Map(mainAssignments.map((row) => [row.slug, row]));

        const edits = twinAssignments.flatMap((row) => this.toEdit(row, baselineByTestCase, mainBySlug));
        const recipeEdits = this.toRecipeEdits(twinRecipes, baselineRecipes, mainRecipes);
        const mainSuite = mainAssignments
            .map((row) => ({
                slug: row.slug,
                name: row.name,
                flow: row.flow,
                description: planSummary(row.prompt),
            }))
            .sort((a, b) => a.flow.localeCompare(b.flow) || a.name.localeCompare(b.name));

        this.logger.info("Merge inputs read", {
            snapshot: { snapshotId: twinSnapshotId },
            extra: {
                newTests: edits.filter((edit) => edit.kind === "new_test").length,
                modifications: edits.filter((edit) => edit.kind === "modification").length,
                recipeEdits: recipeEdits.length,
                mainSuiteSize: mainSuite.length,
            },
        });
        return { edits, mainSuite, recipeEdits };
    }

    /**
     * A recipe edit exists when the branch's twin `create` graph differs from its fork-point baseline. We can
     * only reconcile against a baseline (the "did the branch change it?" signal), so a scenario with a twin
     * recipe but no baseline recipe is skipped rather than treated as a wholesale add.
     */
    private toRecipeEdits(
        twin: Map<string, RecipeRow>,
        baseline: Map<string, RecipeRow>,
        main: Map<string, RecipeRow>,
    ): RecipeMergeEdit[] {
        const edits: RecipeMergeEdit[] = [];
        for (const [scenarioId, twinRecipe] of twin) {
            const base = baseline.get(scenarioId);
            if (base == null || base.createGraph === twinRecipe.createGraph) continue;
            edits.push({
                scenarioId,
                scenarioName: twinRecipe.name,
                proposedCreateGraph: twinRecipe.createGraph,
                baseCreateGraph: base.createGraph,
                mainCreateGraph: main.get(scenarioId)?.createGraph,
            });
        }
        return edits;
    }

    private toEdit(
        row: AssignmentRow,
        baselineByTestCase: Map<string, AssignmentRow>,
        mainBySlug: Map<string, AssignmentRow>,
    ): BranchEdit[] {
        const baseline = baselineByTestCase.get(row.testCaseId);
        const proposedPlan = row.prompt;
        if (proposedPlan == null) return [];

        // The persisted test case description (the falsifiable claim the selector wrote) is the real one to
        // carry onto main; fall back to a plan-frontmatter summary only if the test case has no description.
        const description = row.description ?? planSummary(proposedPlan);

        if (baseline == null) {
            // Assigned to the twin but not the fork-point baseline - a test the branch's investigation added.
            return [
                {
                    kind: "new_test",
                    ref: row.slug,
                    name: row.name,
                    flow: row.flow,
                    description,
                    proposedPlan,
                },
            ];
        }

        // On both, but the branch repointed the pinned plan - a modification. An unchanged planId is a no-op.
        if (baseline.planId === row.planId) return [];
        return [
            {
                kind: "modification",
                ref: row.slug,
                name: row.name,
                flow: row.flow,
                description,
                proposedPlan,
                basePlan: baseline.prompt,
                mainCurrentPlan: mainBySlug.get(row.slug)?.prompt,
            },
        ];
    }

    private async loadAssignments(snapshotId: string): Promise<AssignmentRow[]> {
        const assignments = await this.db.testCaseAssignment.findMany({
            where: { snapshotId, quarantineIssueId: null, planId: { not: null } },
            select: {
                testCaseId: true,
                planId: true,
                testCase: {
                    select: { slug: true, name: true, description: true, folder: { select: { name: true } } },
                },
                plan: { select: { prompt: true } },
            },
        });
        return assignments.map((assignment) => ({
            testCaseId: assignment.testCaseId,
            planId: assignment.planId,
            slug: assignment.testCase.slug,
            name: assignment.testCase.name,
            flow: assignment.testCase.folder.name,
            description: assignment.testCase.description ?? undefined,
            prompt: assignment.plan?.prompt ?? undefined,
        }));
    }

    private async loadAssignmentsByTestCase(snapshotId: string): Promise<Map<string, AssignmentRow>> {
        const rows = await this.loadAssignments(snapshotId);
        return new Map(rows.map((row) => [row.testCaseId, row]));
    }

    /** The `create` graph of every scenario recipe pinned to a snapshot, keyed by scenarioId, for the recipe diff. */
    private async loadRecipesByScenario(snapshotId: string): Promise<Map<string, RecipeRow>> {
        const versions = await this.db.scenarioRecipeVersion.findMany({
            where: { snapshotId },
            select: { scenarioId: true, scenarioNameSnapshot: true, fixtureJson: true },
        });
        return new Map(
            versions.map((version) => [
                version.scenarioId,
                {
                    scenarioId: version.scenarioId,
                    name: version.scenarioNameSnapshot,
                    createGraph: JSON.stringify(version.fixtureJson.create ?? {}),
                },
            ]),
        );
    }
}
