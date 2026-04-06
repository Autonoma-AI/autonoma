import type { GitHubInstallationClient } from "@autonoma/github";
import { describe, expect, it, vi } from "vitest";
import type { BugReport } from "../../src/tools/bug-found-tool";

const bugReport: BugReport = {
    slug: "checkout-flow",
    testName: "Checkout flow",
    summary: "Payment button is unresponsive",
    detailedExplanation: "The payment button does not respond to clicks after form submission.",
    affectedFiles: ["src/components/PaymentButton.tsx"],
    fixPrompt: "Check the onClick handler in PaymentButton.tsx",
};

describe("reportBug", () => {
    it("creates a GitHub issue with the bug report", async () => {
        const { reportBug } = await import("../../src/callbacks/report-bug");

        const mockGithubClient = {
            createIssue: vi.fn().mockResolvedValue({
                number: 42,
                url: "https://github.com/org/repo/issues/42",
            }),
        } as unknown as GitHubInstallationClient;

        await reportBug(bugReport, {
            repoFullName: "org/repo",
            headSha: "abc12345def",
            githubClient: mockGithubClient,
        });

        expect(mockGithubClient.createIssue).toHaveBeenCalledWith(
            "org",
            "repo",
            "[Autonoma] Bug detected: Payment button is unresponsive",
            expect.stringContaining("Payment button is unresponsive"),
            ["autonoma", "bug"],
        );
    });
});
