import type { GitHubInstallationClient } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import type { ReportedBug } from "../tools/report-bug-tool";

interface ReportBugDeps {
    repoId: number;
    headSha: string;
    githubClient: GitHubInstallationClient;
}

export async function reportBug(report: ReportedBug, { repoId, headSha, githubClient }: ReportBugDeps): Promise<void> {
    logger.info("Reporting bug", { summary: report.summary, repoId });

    const body = formatBugIssueBody(report, headSha);
    const title = `[Autonoma] Bug detected: ${report.summary}`;
    const issue = await githubClient.createIssue(repoId, title, body, ["autonoma", "bug"]);

    logger.info("GitHub issue created", { issueNumber: issue.number, issueUrl: issue.url });
}

function formatBugIssueBody(report: ReportedBug, headSha: string): string {
    const affectedFilesList = report.affectedFiles.map((f) => `- \`${f}\``).join("\n");

    const lines = [
        "## Bug Report (Automated)",
        "",
        `**Detected by Autonoma's diff analysis agent on commit \`${headSha.slice(0, 8)}\`.**`,
        "",
        "### Summary",
        report.summary,
        "",
        "### Details",
        report.details,
        "",
        "### Test Case",
        `- **Slug:** \`${report.slug}\``,
        "",
        "### Affected Files",
        affectedFilesList,
        "",
        "### Suggested Fix",
        "```",
        report.fixPrompt,
        "```",
        "",
        "---",
        "*This issue was automatically created by [Autonoma](https://autonoma.app).*",
    ];

    return lines.join("\n");
}
