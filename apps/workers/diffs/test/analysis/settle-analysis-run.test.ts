import type { AnalysisRunOutcome } from "@autonoma/types";
import { describe, expect, test } from "vitest";
import type { AnalysisGitHub } from "../../src/activities/analysis/analysis-github";
import { settleAnalysisGitHub } from "../../src/activities/analysis/settle-analysis-github";

describe("settleAnalysisGitHub", () => {
    test("contains a failed check write and still posts the successful-run comment", async () => {
        const github = new FakeAnalysisGitHub();
        github.failCheckWrites = true;

        await settleAnalysisGitHub({
            snapshotId: "snapshot-1",
            outcome: { kind: "succeeded" },
            github,
        });

        expect(github.checkAttempts).toBe(1);
        expect(github.comments).toEqual(["pr"]);
    });

    test("writes a neutral check and still posts a comment for a failed run", async () => {
        const github = new FakeAnalysisGitHub();
        const outcome: AnalysisRunOutcome = { kind: "failed", reason: "Reporter failed" };

        await settleAnalysisGitHub({ snapshotId: "snapshot-1", outcome, github });

        // The unified PR comment renders a failed run (could-not-complete), so it posts here too.
        expect(github.checkConclusions).toEqual(["neutral"]);
        expect(github.comments).toEqual(["pr"]);
    });

    test("does not contact GitHub for a superseded run", async () => {
        const github = new FakeAnalysisGitHub();
        const outcome: AnalysisRunOutcome = { kind: "superseded", reason: "Newer push" };

        await settleAnalysisGitHub({ snapshotId: "snapshot-1", outcome, github });

        expect(github.checkConclusions).toEqual([]);
        expect(github.comments).toEqual([]);
    });

    test("writes a passing check and a comment for a succeeded run", async () => {
        const github = new FakeAnalysisGitHub();

        await settleAnalysisGitHub({
            snapshotId: "snapshot-1",
            outcome: { kind: "succeeded" },
            github,
        });

        expect(github.checkConclusions).toEqual(["success"]);
        expect(github.comments).toEqual(["pr"]);
    });
});

class FakeAnalysisGitHub implements AnalysisGitHub {
    public failCheckWrites = false;
    public checkAttempts = 0;
    public readonly checkConclusions: Array<"success" | "neutral"> = [];
    public readonly comments: string[] = [];

    public async conclude(outcome: AnalysisRunOutcome): Promise<void> {
        this.checkAttempts += 1;
        if (this.failCheckWrites) throw new Error("GitHub check write failed");
        this.checkConclusions.push(outcome.kind === "succeeded" ? "success" : "neutral");
    }

    public async comment(): Promise<void> {
        this.comments.push("pr");
    }
}
