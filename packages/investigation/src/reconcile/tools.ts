import { type Tool, tool } from "ai";
import { z } from "zod";
import { createGitDiffTool, createGrepCodeTool, createReadCodeTool } from "../classify/tools";
import { createToolBudget } from "../tool-output";
import type { ReconcilableFinding, ReconcileDeps } from "./dependencies";

/** A one-line index entry so the agent can scan every finding before deciding which to read in full. */
function indexLine(finding: ReconcilableFinding): string {
    const confidence = finding.confidence != null ? ` (${finding.confidence})` : "";
    return `- ${finding.id} [${finding.category}${confidence}]: ${finding.headline}`;
}

/** The compact index of all findings - built once, reused by the prompt and the list_findings tool. */
export function renderFindingIndex(findings: ReconcilableFinding[]): string {
    return findings.map(indexLine).join("\n");
}

/** The full body of one finding: everything that reveals its underlying cause (no run media). */
function renderFinding(finding: ReconcilableFinding): string {
    const lines = [
        `id: ${finding.id}`,
        `test slug: ${finding.slug}`,
        `category: ${finding.category}${finding.confidence != null ? ` (confidence: ${finding.confidence})` : ""}`,
        `headline: ${finding.headline}`,
    ];
    if (finding.rootCause != null) lines.push("", `root cause: ${finding.rootCause}`);
    if (finding.whatHappened != null) lines.push("", `what happened: ${finding.whatHappened}`);
    if (finding.observedAppIssues != null) lines.push("", `observed app issues: ${finding.observedAppIssues}`);
    if (finding.remediation != null) lines.push("", `remediation: ${finding.remediation}`);
    if (finding.evidence.length > 0) {
        lines.push("", "evidence:");
        for (const item of finding.evidence) {
            const where = item.file != null ? ` ${item.file}${item.lines != null ? `:${item.lines}` : ""}` : "";
            lines.push(`  - [${item.source}]${where} ${item.detail}`);
        }
    }
    return lines.join("\n");
}

/** List every finding as a one-line index (id, category, headline) - the agent's starting map. */
export function createListFindingsTool(findings: ReconcilableFinding[]): Tool {
    return tool({
        description:
            "List every finding in this run as a one-line index (id, category, headline). Call it first to see the whole set, then read_finding the ones that might share a cause.",
        inputSchema: z.object({}),
        execute: async () => renderFindingIndex(findings),
    });
}

/** Read one finding in full (root cause, what happened, evidence) so the agent can compare underlying causes. */
export function createReadFindingTool(findings: ReconcilableFinding[]): Tool {
    const byId = new Map(findings.map((finding) => [finding.id, finding]));
    return tool({
        description:
            "Read one finding in full by id: its root cause, what happened, observed app issues, remediation, and the code/run evidence it cited. Use this to compare two findings' underlying causes before merging them.",
        inputSchema: z.object({ id: z.string().describe("the finding id, from list_findings") }),
        execute: async ({ id }) => {
            const finding = byId.get(id);
            if (finding == null) return `No finding with id "${id}". Call list_findings for the valid ids.`;
            return renderFinding(finding);
        },
    });
}

/**
 * Assemble the reconciliation agent's tools. Finding navigation (list_findings / read_finding) is always
 * available; the code tools (read_code / grep_code / git_diff - the SAME ones the classifier uses over the
 * cloned repo) appear only when a codebase was wired, so the agent can confirm two findings point at the SAME
 * file/gate/seed before merging them. Read-only: no run_script / preview here (reconciliation never mutates).
 */
export function buildReconcileTools(deps: ReconcileDeps): Record<string, Tool> {
    const tools: Record<string, Tool> = {
        list_findings: createListFindingsTool(deps.findings),
        read_finding: createReadFindingTool(deps.findings),
    };
    if (deps.codebase != null) {
        const cap = createToolBudget();
        tools.read_code = createReadCodeTool(deps.codebase, cap);
        tools.grep_code = createGrepCodeTool(deps.codebase, cap);
        tools.git_diff = createGitDiffTool(deps.codebase, cap);
    }
    return tools;
}
