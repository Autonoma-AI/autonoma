import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ReviewRubric } from "../../src/agents/05-test-generator/rubrics";

/**
 * The effectVerification dimension has to reach the fix path to do anything: a
 * verdict that never becomes a failed dimension is a verdict the fix agent never
 * sees. Stub the per-rubric reviewer (a model call otherwise) and drive the real
 * merge in reviewOneTest, which is where a rubric's verdict turns into the
 * failedDimensions the fix prompt reads.
 */
const runReviewPass = vi.hoisted(() => vi.fn());
vi.mock("../../src/agents/05-test-generator/review-pass", () => ({ runReviewPass }));

const { reviewOneTest } = await import("../../src/agents/05-test-generator/review");

beforeAll(() => {
    process.env.DONT_TRACK = "1";
});

const TEST = { relativePath: "board/drag.md", content: "# drag", flow: "board" };

describe("effectVerification review dimension", () => {
    it("surfaces a failing effectVerification as a failed dimension the fix pass will act on", async () => {
        runReviewPass.mockImplementation(async (_content: string, _path: string, rubric: ReviewRubric) => {
            if (rubric.name !== "flow-completeness") return {};
            return {
                actionCompletion: { pass: true, evidence: "reaches an outcome" },
                mutationVerification: { pass: true, evidence: "checks the list, not a toast" },
                effectVerification: {
                    pass: false,
                    evidence: "verification only re-asserts the filter chip is visible, not that the list narrowed",
                    suggestion: "assert the non-matching rows are gone from the list",
                },
            };
        });

        const review = await reviewOneTest({ projectRoot: "/p", model: "m", test: TEST });

        expect(review.failedDimensions).toContain("effectVerification");
        expect(review.dimensions.effectVerification?.pass).toBe(false);
    });

    it("fails effectVerification open when a rubric returns no verdict for it", async () => {
        runReviewPass.mockImplementation(async () => ({}));

        const review = await reviewOneTest({ projectRoot: "/p", model: "m", test: TEST });

        expect(review.failedDimensions).not.toContain("effectVerification");
        expect(review.dimensions.effectVerification?.pass).toBe(true);
    });
});
