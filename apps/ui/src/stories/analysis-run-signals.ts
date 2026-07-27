import type { AnalysisFindingView } from "@autonoma/types";

/**
 * The per-test run signals every analysis finding carries, keyed by slug and shared by the authoritative PR- and
 * snapshot-page stories (which fixture the same five-test run with different prose). These are what the
 * suite-changes surfaces categorize on, so the set below deliberately spans all four buckets: one `proposed` test
 * (added), one self-healed pre-existing test (modified), and three selected-but-untouched ones (checked).
 */
const RUN_SIGNALS: Record<
    string,
    Pick<AnalysisFindingView, "origin" | "planEdited" | "selectionReason"> & {
        selfHealNote?: string;
    }
> = {
    "checkout-place-order": {
        origin: "pre_existing",
        planEdited: false,
        selectionReason: "The diff rewrites the checkout submit handler this test drives.",
    },
    "guest-add-to-cart": {
        origin: "proposed",
        planEdited: false,
        selectionReason:
            "New test authored by Impact Analysis for functionality this PR adds - run it to confirm the app " +
            "supports the scenario it covers.",
    },
    "cart-badge-count": {
        origin: "pre_existing",
        planEdited: true,
        selectionReason: "The cart badge counter markup changed, and this test asserts its text.",
        selfHealNote: "The test's plan was rewritten during a self-heal re-run before this verdict was reached.",
    },
    "coupon-apply": {
        origin: "pre_existing",
        planEdited: false,
        selectionReason: "The coupon totals helper the diff touches feeds this test's assertions.",
    },
    "payment-iframe": {
        origin: "pre_existing",
        planEdited: false,
        selectionReason: "The payment step renders inside the iframe the diff re-mounts.",
    },
};

/**
 * Completes a story's finding fixture with the fields the API resolves rather than the classifier: the generation
 * the verdict judged, the test it is about, and the run signals above. Keeps the stories to their prose.
 */
export function withRunSignals(
    finding: Omit<AnalysisFindingView, "generationId" | "testCase" | "origin" | "planEdited" | "selectionReason">,
): AnalysisFindingView {
    const signals = RUN_SIGNALS[finding.slug];
    return {
        ...finding,
        generationId: `gen_${finding.slug}`,
        testCase: { id: `tc_${finding.slug}`, name: `${finding.slug}.md`, slug: finding.slug },
        origin: signals?.origin,
        planEdited: signals?.planEdited,
        selectionReason: signals?.selectionReason,
        selfHealNote: signals?.selfHealNote,
    };
}
