import { type AgentConfig, AgentLoop, FixableToolError } from "@autonoma/ai";
import {
    analysisFindingBucket,
    type EvidenceManifestEntry,
    type PrimaryScreenshot,
    type SuspectedCause,
} from "@autonoma/types";
import type { CodebaseLoop } from "../../agents/tools/codebase/codebase-loop";
import type { ScreenshotLoader } from "../../agents/tools/screenshot/screenshot-types";
import type { Codebase } from "../../codebase";
import { type CoverageViolations, computeCoverageViolations } from "./coverage";
import { groundNarrative, resolvePrimaryScreenshot, validateSuspectedCause } from "./evidence";
import type { RecordedIssueAction } from "./issue-actions";
import type {
    ReporterEvidenceAsset,
    ReporterExistingIssue,
    ReporterFinding,
    ReporterResult,
    ReporterScenarioLoader,
    ReporterScenarioRecipe,
    ReporterScenarioSummary,
} from "./types";

interface ReporterAgentLoopParams extends AgentConfig<ReporterResult> {
    codebase: Codebase;
    screenshotLoader?: ScreenshotLoader;
    scenarioLoader?: ReporterScenarioLoader;
    findings: readonly ReporterFinding[];
    existingIssues: readonly ReporterExistingIssue[];
    scenarioIndex: readonly ReporterScenarioSummary[];
}

/**
 * Per-run state for the {@link ReporterAgent}. Holds the run's minted-evidence allow-list (the single anchor for
 * grounding: an image or hero screenshot can only surface an asset the agent really fetched) and the issue
 * reconciliations recorded so far, which the result tool checks against the coverage guarantees before finishing.
 * All state is private: the tools reach it only through this class's methods (fetch/read/ground/validate + the
 * input guards), so no code outside the loop can read the raw inputs or mutate the allow-list. The one public
 * field is `codebase`, required by {@link CodebaseLoop} for the shared read-only `bash` tool.
 */
export class ReporterAgentLoop extends AgentLoop<ReporterResult> implements CodebaseLoop {
    public readonly codebase: Codebase;
    private readonly screenshotLoader?: ScreenshotLoader;
    private readonly scenarioLoader?: ReporterScenarioLoader;

    private readonly findings: readonly ReporterFinding[];
    private readonly existingIssues: readonly ReporterExistingIssue[];
    private readonly scenarioIndex: readonly ReporterScenarioSummary[];

    /** This job's findings, keyed by slug - the set of tests that ran, for tool validation + coverage checks. */
    private readonly findingsBySlug: ReadonlyMap<string, ReporterFinding>;
    /** Every fetchable screenshot across all findings, keyed by its stable assetId. */
    private readonly assetsById: ReadonlyMap<string, ReporterEvidenceAsset>;
    /** The branch's existing issues (open + resolved), keyed by id. */
    private readonly existingIssuesById: ReadonlyMap<string, ReporterExistingIssue>;

    /**
     * The evidence the agent has actually fetched this run, keyed by the assetId `fetch_evidence` minted. This is
     * the allow-list: a narrative or hero screenshot can only reference an id present here; every other referenced
     * id is dropped at persist time.
     */
    private readonly fetchedEvidence = new Map<string, EvidenceManifestEntry>();

    /** The issue reconciliations recorded this run, in call order. Exposed read-only via {@link issueActions}. */
    private readonly recordedActions: RecordedIssueAction[] = [];
    /** Existing issue ids already acted on (carry-forward or resolve) - each may be handled at most once. */
    private readonly handledIssueIds = new Set<string>();

    constructor({
        codebase,
        screenshotLoader,
        scenarioLoader,
        findings,
        existingIssues,
        scenarioIndex,
        ...config
    }: ReporterAgentLoopParams) {
        super(config);
        this.codebase = codebase;
        this.screenshotLoader = screenshotLoader;
        this.scenarioLoader = scenarioLoader;
        this.findings = findings;
        this.existingIssues = existingIssues;
        this.scenarioIndex = scenarioIndex;

        this.findingsBySlug = new Map(findings.map((f) => [f.slug, f]));
        this.assetsById = new Map(findings.flatMap((f) => f.screenshots.map((a) => [a.assetId, a])));
        this.existingIssuesById = new Map(existingIssues.map((i) => [i.id, i]));
    }

    /** The reconciliations recorded so far, in call order - the result tool assembles the run's issues from these. */
    public get issueActions(): readonly RecordedIssueAction[] {
        return this.recordedActions;
    }

    /** Record one issue reconciliation the agent emitted. */
    public recordIssueAction(action: RecordedIssueAction): void {
        this.recordedActions.push(action);
        if (action.kind === "carry_forward" || action.kind === "resolve") {
            this.handledIssueIds.add(action.existingIssueId);
        }
    }

    protected override snapshotPartial(): { issues: RecordedIssueAction[] } {
        return { issues: [...this.recordedActions] };
    }

    // --- Coverage guarantees --------------------------------------------------------------------------------

    /**
     * The three structural coverage guarantees this run must satisfy before finish accepts: every live
     * `client_bug` finding is covered by an issue; every open issue whose covering test(s) re-ran and passed is
     * resolved; every open issue whose covering test(s) still failed is carried forward. Computed over this run's
     * own findings + existing issues + recorded actions, so the result tool never reaches into that state itself.
     */
    public checkCoverage(): CoverageViolations {
        return computeCoverageViolations(this.findings, this.existingIssues, this.recordedActions);
    }

    // --- Evidence: the fetched-asset allow-list -------------------------------------------------------------

    /**
     * Fetch one finding's screenshot and mint its `evidence:<assetId>` token on this run's allow-list, so a
     * later narrative or hero may embed exactly the frames the agent really saw. Owns the load-then-record
     * ordering that IS the grounding invariant: nothing enters the allow-list without a successful load, and the
     * only way in is through here. Throws a fixable error for an unknown id or bytes that will not load - both
     * are errors the model must handle (proceed without that screenshot), never a "successful" empty fetch.
     */
    public async fetchEvidence(assetId: string): Promise<{ label: string; base64: string }> {
        const asset = this.assetsById.get(assetId);
        if (asset == null) {
            throw new FixableToolError(
                `Unknown screenshot assetId "${assetId}". Use only an assetId listed under a finding.`,
            );
        }

        const base64 = await this.loadBytes(asset);
        if (base64 == null) {
            throw new FixableToolError(
                `The screenshot "${assetId}" (${asset.label}) could not be loaded, so it cannot be embedded. Proceed without it.`,
            );
        }

        this.fetchedEvidence.set(
            assetId,
            asset.pin != null
                ? { assetId, s3Key: asset.s3Key, kind: "screenshot", pin: asset.pin }
                : { assetId, s3Key: asset.s3Key, kind: "screenshot" },
        );
        return { label: asset.label, base64 };
    }

    /** Load and base64 a screenshot's bytes; a failed load (or absent loader) returns undefined, never throws. */
    private async loadBytes(asset: ReporterEvidenceAsset): Promise<string | undefined> {
        if (this.screenshotLoader == null) return undefined;
        try {
            const buffer = await this.screenshotLoader.loadScreenshot(asset.s3Key);
            return buffer.toString("base64");
        } catch (err) {
            this.logger.warn("Failed to load screenshot; it cannot be embedded", {
                extra: { s3Key: asset.s3Key, err },
            });
            return undefined;
        }
    }

    /** Strip every unfetched `evidence:` image from prose and return the manifest of the surviving fetched ones. */
    public groundNarrative(markdown: string): { markdown: string; manifest: EvidenceManifestEntry[] } {
        return groundNarrative(markdown, this.fetchedEvidence);
    }

    /** Resolve a model-chosen hero assetId to a concrete frame - only when that asset was fetched this run. */
    public resolvePrimaryScreenshot(assetId: string | undefined): PrimaryScreenshot | undefined {
        return resolvePrimaryScreenshot(assetId, this.fetchedEvidence);
    }

    /** Validate a suspected cause's code references against this run's checked-out repo, dropping fabrications. */
    public validateSuspectedCause(cause: SuspectedCause | undefined): SuspectedCause | undefined {
        return validateSuspectedCause(cause, this.codebase.root);
    }

    // --- Scenarios ------------------------------------------------------------------------------------------

    /**
     * Load one scenario's full recipe by id, validating it against this run's scenario index and the injected
     * loader. Throws a fixable error for an unknown id or one with no readable recipe this run, so the tool never
     * has to reach into the index or loader itself.
     */
    public async readScenario(scenarioId: string): Promise<ReporterScenarioRecipe> {
        const known = this.scenarioIndex.some((s) => s.id === scenarioId);
        if (!known) {
            throw new FixableToolError(
                `Scenario "${scenarioId}" not found. Use one of the scenario ids listed in the scenario index in the prompt.`,
            );
        }

        const recipe = await this.scenarioLoader?.loadRecipe(scenarioId);
        if (recipe == null) {
            throw new FixableToolError(
                `Scenario "${scenarioId}" has no readable recipe in this run; reason about it from the scenario index summary instead.`,
            );
        }
        return recipe;
    }

    // --- Input guards for the issue tools -------------------------------------------------------------------
    // Each reads this run's static inputs / recorded state and throws a fixable error the model can self-correct.

    /** Reject any slug that is not one of THIS job's findings; the model may only cover tests that actually ran. */
    public assertKnownFindingSlugs(slugs: readonly string[]): void {
        const unknown = slugs.filter((slug) => !this.findingsBySlug.has(slug));
        if (unknown.length > 0) {
            throw new FixableToolError(
                `Unknown finding slug(s): ${unknown.join(", ")}. Use only slugs from this job's findings list.`,
            );
        }
    }

    /** Reject a `primaryScreenshotAssetId` that no finding offered; an unfetched one is dropped later, not here. */
    public assertKnownAsset(assetId: string | undefined): void {
        if (assetId == null) return;
        if (!this.assetsById.has(assetId)) {
            throw new FixableToolError(
                `Unknown screenshot assetId "${assetId}". Use only an assetId listed under a finding, and fetch it with fetch_evidence first.`,
            );
        }
    }

    /** Reject an `existingIssueId` that is not in the branch's existing-issues list, or one already acted on. */
    public assertHandleableIssue(existingIssueId: string): void {
        if (!this.existingIssuesById.has(existingIssueId)) {
            throw new FixableToolError(
                `Unknown existing issue id "${existingIssueId}". Use only an id from the Existing issues list.`,
            );
        }
        if (this.handledIssueIds.has(existingIssueId)) {
            throw new FixableToolError(
                `Existing issue "${existingIssueId}" was already acted on this run. Each issue may be carried forward or resolved at most once.`,
            );
        }
    }

    /**
     * Reject a resolve whose passing finding does not cover the issue, did not run this job, or did not actually
     * pass - only a covering test that re-ran and passed is proof the problem is gone.
     */
    public assertResolvable(existingIssueId: string, resolvingFindingSlug: string): void {
        const issue = this.existingIssuesById.get(existingIssueId);
        if (issue != null && !issue.findingSlugs.includes(resolvingFindingSlug)) {
            throw new FixableToolError(
                `Finding "${resolvingFindingSlug}" is not a test that issue "${existingIssueId}" covers. Resolve with a slug the issue actually covers.`,
            );
        }

        const finding = this.findingsBySlug.get(resolvingFindingSlug);
        if (finding == null) {
            throw new FixableToolError(
                `Finding "${resolvingFindingSlug}" did not run this job, so it cannot prove a resolution.`,
            );
        }
        if (analysisFindingBucket(finding.category) !== "passed") {
            throw new FixableToolError(
                `Finding "${resolvingFindingSlug}" did not pass this job (verdict: ${finding.category}); only a passing covering test resolves an issue.`,
            );
        }
    }
}
