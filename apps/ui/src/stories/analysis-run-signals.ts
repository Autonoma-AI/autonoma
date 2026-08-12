import type { AnalysisClassificationSummary, AnalysisFindingView } from "@autonoma/types";

/**
 * The per-test run signals every analysis finding carries, keyed by slug and shared by the authoritative PR- and
 * snapshot-page stories (which fixture the same five-test run with different prose). These are what the
 * suite-changes surfaces categorize on, so the set below deliberately spans all four buckets: one `proposed` test
 * (added), one self-healed pre-existing test (modified - it is the one with two classifications), and three
 * selected-but-untouched ones (checked).
 */
const RUN_SIGNALS: Record<
    string,
    Pick<AnalysisFindingView, "origin" | "selectionReason"> & {
        /** The verdict the run superseded, for the one test the Investigator rewrote and re-ran. */
        supersededBy?: { category: string; headline: string };
    }
> = {
    "checkout-place-order": {
        origin: "pre_existing",
        selectionReason: "The diff rewrites the checkout submit handler this test drives.",
    },
    "guest-add-to-cart": {
        origin: "proposed",
        selectionReason:
            "New test authored by Impact Analysis for functionality this PR adds - run it to confirm the app " +
            "supports the scenario it covers.",
    },
    "cart-badge-count": {
        origin: "pre_existing",
        selectionReason: "The cart badge counter markup changed, and this test asserts its text.",
        supersededBy: {
            category: "plan_mismatch",
            headline: "The badge renders the new count; the test still asserts the old copy.",
        },
    },
    "coupon-apply": {
        origin: "pre_existing",
        selectionReason: "The coupon totals helper the diff touches feeds this test's assertions.",
    },
    "payment-iframe": {
        origin: "pre_existing",
        selectionReason: "The payment step renders inside the iframe the diff re-mounts.",
    },
};

/**
 * Completes a story's finding fixture with the fields the API resolves rather than the classifier: the generation
 * the verdict judged, the test it is about, the run signals above, and the classification history (one entry, or
 * two for the self-healed test). Keeps the stories to their prose.
 */
export function withRunSignals(
    finding: Omit<
        AnalysisFindingView,
        "generationId" | "testCase" | "origin" | "selectionReason" | "classifications" | "selfHealed"
    >,
): AnalysisFindingView {
    const signals = RUN_SIGNALS[finding.slug];
    return {
        ...finding,
        generationId: `gen_${finding.slug}`,
        testCase: { id: `tc_${finding.slug}`, name: `${finding.slug}.md`, slug: finding.slug },
        origin: signals?.origin,
        selectionReason: signals?.selectionReason,
        selfHealed: signals?.supersededBy != null,
        classifications: buildClassifications(finding.slug, finding.category, finding.headline, signals?.supersededBy),
    };
}

/** The finding's history: the superseded iteration (when the test self-healed) followed by the current verdict. */
function buildClassifications(
    slug: string,
    category: string,
    headline: string,
    supersededBy: { category: string; headline: string } | undefined,
): AnalysisClassificationSummary[] {
    const current: AnalysisClassificationSummary = {
        id: `cls_${slug}_current`,
        number: supersededBy != null ? 2 : 1,
        generationId: `gen_${slug}`,
        category,
        headline,
        createdAt: new Date("2026-07-27T18:24:56Z"),
        conversationUrl: `https://example.test/${slug}-2-conversation.json`,
    };
    if (supersededBy == null) return [current];
    return [
        {
            id: `cls_${slug}_1`,
            number: 1,
            generationId: `gen_${slug}_1`,
            category: supersededBy.category,
            headline: supersededBy.headline,
            createdAt: new Date("2026-07-27T18:03:06Z"),
            conversationUrl: `https://example.test/${slug}-1-conversation.json`,
        },
        current,
    ];
}
