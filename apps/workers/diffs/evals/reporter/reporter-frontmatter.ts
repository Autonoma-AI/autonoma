import {
    type ReporterIssueContent,
    type ReporterResult,
    reporterIssueKindSchema,
    reporterIssueSeveritySchema,
} from "@autonoma/diffs/analysis";
import {
    type CheckFailure,
    baseFrontmatterSchema,
    checkCountBounds,
    checkEnumEquality,
    checkIdentifierSet,
    countBoundsSchema,
    identifierSetCheckSchema,
} from "@autonoma/evals";
import { z } from "zod";

/** How many times a single case is reported per suite run. One is enough to gate; more measures stability. */
const DEFAULT_RUNS = 1;

/**
 * The headline dedup assertion: how this run reconciled its findings against the branch's existing issues. This is
 * the one judgement nothing downstream corrects - the coverage guarantees self-heal a dropped bug or an unresolved
 * pass before a result exists, but whether THIS finding is the SAME problem as an existing issue (carry it forward)
 * or a genuinely new one (open it) is the model's call alone.
 *
 * - `open` bounds how many brand-new issues this run mints. A recurrence asserts `{ maxCount: 0 }`.
 * - `carryForward` / `resolve` are identifier sets over the EXISTING issue ids each reconciliation targets. A new
 *   problem asserts `carryForward: { exact: [] }`; a recurrence asserts `carryForward: { include: [issueId] }`.
 *   `resolve` closes an issue whose covering test(s) re-ran and passed. An `open` mints a fresh issue with no id
 *   yet, so its side is counted (via `open`), never named here.
 */
const reporterIssueChecksSchema = z.object({
    open: countBoundsSchema.optional(),
    carryForward: identifierSetCheckSchema.optional(),
    resolve: identifierSetCheckSchema.optional(),
});

/**
 * One issue's kind + severity, identified by a finding slug it covers.
 *
 * A slug is the handle rather than the existing issue id because it is the one identifier that works for BOTH a
 * newly-opened issue (which has no id yet) and a carried-forward one, and a test slug is legible in a case where a
 * minted cuid is not. The referenced issue is the open/carry_forward reconciliation whose covered set contains the
 * slug; a `resolve` carries no content, so it is never the target of an `issueDetails` entry.
 */
const reporterIssueDetailSchema = z.object({
    findingSlug: z.string(),
    kind: reporterIssueKindSchema.optional(),
    severity: reporterIssueSeveritySchema.optional(),
});

/**
 * A flow-membership check: which test slugs a named flow must (not) cluster. The flow is matched by its authored
 * title, case-insensitively and trimmed - the Reporter names flows, so a lenient title match is how a case points
 * at one. Only MEMBERSHIP is graded (which tests land together); a flow's status and owner are derived in code and
 * covered by `flows.test.ts`, never asserted here.
 */
const reporterFlowCheckSchema = identifierSetCheckSchema.extend({
    title: z.string(),
});

/**
 * Deterministic checks for a Reporter case, layered on the shared base.
 *
 * What is graded, and what is deliberately not:
 *
 * - `issues` - the open-vs-carry-vs-resolve dedup call (see {@link reporterIssueChecksSchema}). The headline.
 * - `issueDetails` - each asserted issue's kind + severity (see {@link reporterIssueDetailSchema}).
 * - `flows` - flow MEMBERSHIP (see {@link reporterFlowCheckSchema}).
 * - `unknownSlugs` is checked ALWAYS (not a field, see {@link checkUnknownSlugs}): a flow citing a slug outside the
 *   branch map is a hallucination, the one flow correction that is a real error rather than a clustering-quality
 *   signal. The swept + duplicate counts are the quality signals - recorded by the evaluation, never gating,
 *   because nothing rejects a bad partition.
 *
 * The three coverage guarantees and grounding are NOT asserted: each self-heals via a `FixableToolError` before a
 * `ReporterResult` exists, so an assertion on the output would be tautological. Flow status/owner are derived in
 * code, covered by their own test.
 */
export const reporterFrontmatterSchema = baseFrontmatterSchema.extend({
    issues: reporterIssueChecksSchema.optional(),
    issueDetails: z.array(reporterIssueDetailSchema).optional(),
    flows: z.array(reporterFlowCheckSchema).optional(),
    /**
     * How many times to report this case. Above one, EVERY run must satisfy the checks, so this measures whether a
     * reconciliation is stable rather than whether it is reachable. Defaults to one - the Reporter reads no live
     * vision, so a single run is a sound gate.
     */
    runs: z.number().int().positive().default(DEFAULT_RUNS),
});

export type ReporterFrontmatter = z.infer<typeof reporterFrontmatterSchema>;

/** Apply the Reporter deterministic checks to one result. An empty list means the checks passed. */
export function checkReporterResult(result: ReporterResult, frontmatter: ReporterFrontmatter): CheckFailure[] {
    return [
        ...checkUnknownSlugs(result),
        ...checkIssues(result, frontmatter.issues),
        ...checkIssueDetails(result, frontmatter.issueDetails),
        ...checkFlows(result, frontmatter.flows),
    ];
}

/**
 * The one always-on flow invariant: no flow may cite a slug absent from the branch's verdict map. Unlike a swept or
 * duplicate slug (a clustering-quality signal the partition absorbs), an unknown slug is the agent naming a test
 * that does not exist - it is dropped rather than invented, and a case should never pass while one is present.
 */
function checkUnknownSlugs(result: ReporterResult): CheckFailure[] {
    const unknown = result.flowCorrections.unknownSlugs;
    if (unknown.length === 0) return [];
    return [
        {
            check: "flows.unknownSlugs",
            message: `flows cited ${unknown.length} slug(s) not in the branch map: [${unknown.join(", ")}]`,
        },
    ];
}

function checkIssues(result: ReporterResult, spec: ReporterFrontmatter["issues"]): CheckFailure[] {
    if (spec == null) return [];

    const openCount = result.issues.filter((issue) => issue.kind === "open").length;
    const carriedIds = result.issues.flatMap((issue) =>
        issue.kind === "carry_forward" ? [issue.existingIssueId] : [],
    );
    const resolvedIds = result.issues.flatMap((issue) => (issue.kind === "resolve" ? [issue.existingIssueId] : []));

    const failures: CheckFailure[] = [];
    if (spec.open != null) failures.push(...checkCountBounds("issues.open", openCount, spec.open));
    if (spec.carryForward != null) {
        failures.push(...checkIdentifierSet("issues.carryForward", carriedIds, spec.carryForward));
    }
    if (spec.resolve != null) failures.push(...checkIdentifierSet("issues.resolve", resolvedIds, spec.resolve));
    return failures;
}

function checkIssueDetails(result: ReporterResult, details: ReporterFrontmatter["issueDetails"]): CheckFailure[] {
    if (details == null) return [];

    const failures: CheckFailure[] = [];
    for (const detail of details) {
        const content = findIssueContentByFindingSlug(result, detail.findingSlug);
        if (content == null) {
            failures.push({
                check: "issueDetails",
                message: `no open or carried-forward issue covers finding slug "${detail.findingSlug}"`,
            });
            continue;
        }
        if (detail.kind != null) {
            failures.push(...checkEnumEquality(`issueDetails[${detail.findingSlug}].kind`, content.kind, detail.kind));
        }
        if (detail.severity != null) {
            failures.push(
                ...checkEnumEquality(`issueDetails[${detail.findingSlug}].severity`, content.severity, detail.severity),
            );
        }
    }
    return failures;
}

/** The content of the open/carry_forward reconciliation whose covered set contains `slug`, or undefined. */
function findIssueContentByFindingSlug(result: ReporterResult, slug: string): ReporterIssueContent | undefined {
    for (const issue of result.issues) {
        if (issue.kind === "resolve") continue;
        if (issue.content.findingSlugs.includes(slug)) return issue.content;
    }
    return undefined;
}

function checkFlows(result: ReporterResult, specs: ReporterFrontmatter["flows"]): CheckFailure[] {
    if (specs == null) return [];

    const failures: CheckFailure[] = [];
    for (const spec of specs) {
        const wanted = spec.title.trim().toLowerCase();
        const flow = result.flows.find((candidate) => candidate.title.trim().toLowerCase() === wanted);
        if (flow == null) {
            const present = result.flows.map((candidate) => candidate.title).join(", ");
            failures.push({ check: "flows", message: `no flow titled "${spec.title}" (flows present: [${present}])` });
            continue;
        }
        failures.push(...checkIdentifierSet(`flows[${spec.title}]`, flow.testSlugs, spec));
    }
    return failures;
}
