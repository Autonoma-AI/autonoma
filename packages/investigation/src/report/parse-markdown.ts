import type {
    InvestigationEvidence,
    InvestigationFinding,
    InvestigationReportData,
    InvestigationSuggestedTest,
} from "@autonoma/types";

/**
 * Parse a rendered investigation markdown report back into the structured UI contract. This is the inverse of
 * buildReportMarkdown - it exists so the in-app view works on reports written before the worker emitted JSON.
 * It is best-effort and resilient (aux sections degrade to empty rather than throw); the API treats a parse
 * failure as "no rich report" and falls back to the raw markdown link. A round-trip test keeps it in sync
 * with the renderer.
 */
const HEADER_RE = /^#\s+(.+?)\s+·\s+PR\s+#(\d+)\s+\(`([^`]+)`\)/m;
const VERDICT_RE = /^`([^`]+)`\s+·\s+\*\*([^*]+)\*\*\s+·\s+(\S+)\s+confidence\s+·\s+plan:\s+(\S+)\s*$/m;

/** The markers that end the free-text "what happened" block within a finding section. */
const WHAT_HAPPENED_ENDERS = ["> ⚠️ **App issues observed", "**Remediation:**", "**Suggested test fix**", "<details>"];
/** Trailing report-level sections that get appended after the last finding (not `##`-headed). */
const TRAILING_MARKERS = ["\n**PR #", "\n<details>\n<summary>Deployed agent"];

function firstIndexOf(text: string, needles: string[]): number {
    const hits = needles.map((n) => text.indexOf(n)).filter((i) => i >= 0);
    return hits.length > 0 ? Math.min(...hits) : -1;
}

/** Cut a finding's body at the first trailing report-level section, so PR/deployed text never leaks into it. */
function trimTrailing(body: string): string {
    const cut = firstIndexOf(body, TRAILING_MARKERS);
    return cut >= 0 ? body.slice(0, cut) : body;
}

function extractFenced(text: string): string | undefined {
    const match = text.match(/```[a-z]*\n([\s\S]*?)\n```/);
    return match?.[1];
}

function parseLocation(raw: string | undefined): { file?: string; lines?: string } {
    if (raw == null) return {};
    const lastColon = raw.lastIndexOf(":");
    if (lastColon > 0 && /^L?\d/.test(raw.slice(lastColon + 1))) {
        return { file: raw.slice(0, lastColon), lines: raw.slice(lastColon + 1) };
    }
    return { file: raw };
}

function parseEvidence(section: string): InvestigationEvidence[] {
    const start = section.indexOf("**Evidence:**");
    if (start < 0) return [];
    const region = section.slice(start + "**Evidence:**".length);
    // Each item begins with "- [source]"; split on those boundaries.
    const chunks = region.split(/\n(?=- \[)/).filter((c) => c.trim().startsWith("- ["));
    const evidence: InvestigationEvidence[] = [];
    for (const chunk of chunks) {
        const header = chunk.split("\n")[0] ?? "";
        const sourceMatch = header.match(/^- \[([^\]]+)\]/);
        if (sourceMatch == null) continue;
        const source = sourceMatch[1] ?? "";
        const locMatch = header.match(/\(`([^`]+)`\)/);
        const { file, lines } = parseLocation(locMatch?.[1]);
        const detail = header
            .replace(/^- \[[^\]]+\]/, "")
            .replace(/\(`[^`]+`\)/, "")
            .trim();
        evidence.push({ source, detail, file, lines, snippet: extractFenced(chunk) });
    }
    return evidence;
}

function blockBetween(text: string, startMarker: string, endMarkers: string[]): string | undefined {
    const start = text.indexOf(startMarker);
    if (start < 0) return undefined;
    const after = text.slice(start + startMarker.length);
    const end = firstIndexOf(after, endMarkers);
    return (end >= 0 ? after.slice(0, end) : after).trim();
}

function parseFinding(id: string, heading: string, rawBody: string): InvestigationFinding {
    const slugFromError = heading.match(/^(.*?)\s*-\s*classification error$/);
    if (slugFromError != null) {
        return {
            id,
            slug: slugFromError[1] ?? heading,
            category: "classification_error",
            headline: heading,
            error: trimTrailing(rawBody).trim() || "(no verdict)",
            evidence: [],
        };
    }

    const body = trimTrailing(rawBody);
    const verdict = body.match(VERDICT_RE);
    const slug = verdict?.[1] ?? id;
    const category = verdict?.[2]?.trim() ?? "unknown";
    const confidence = verdict?.[3];
    const planFidelity = verdict?.[4];

    const finalScreenshotUrl = body.match(/\[final screenshot\]\(([^)]+)\)/)?.[1];
    const videoUrl = body.match(/\[run video\]\(([^)]+)\)/)?.[1];

    // "What happened" is the prose between the (verdict/media) preamble and the first structured marker.
    const afterVerdict = verdict != null ? body.slice((verdict.index ?? 0) + verdict[0].length) : body;
    const whatEnd = firstIndexOf(afterVerdict, WHAT_HAPPENED_ENDERS);
    const preamble = (whatEnd >= 0 ? afterVerdict.slice(0, whatEnd) : afterVerdict)
        .replace(/^\s*\[final screenshot\][^\n]*\n?/m, "")
        .trim();

    const rootEvidence = body.slice(body.indexOf("Root cause &amp; evidence"));
    const planBlock = blockBetween(body, "<summary>Test plan (what the run was checked against)</summary>", [
        "</details>",
    ]);

    return {
        id,
        slug,
        category,
        confidence,
        planFidelity,
        headline: heading,
        whatHappened: preamble !== "" ? preamble : undefined,
        observedAppIssues: blockBetween(body, "App issues observed (independent of this test):**", [
            "\n\n",
            "**Remediation:**",
            "<details>",
        ]),
        remediation: blockBetween(body, "**Remediation:**", ["\n\n", "<details>", "**Suggested test fix**"]),
        rootCause: blockBetween(rootEvidence, "**Root cause:**", [
            "**False-positive check:**",
            "**Evidence:**",
            "</details>",
        ]),
        falsePositiveRisk: blockBetween(rootEvidence, "**False-positive check:**", ["**Evidence:**", "</details>"]),
        suggestedFixDiff: body.includes("**Suggested test fix**")
            ? extractFenced(body.slice(body.indexOf("**Suggested test fix**")))
            : undefined,
        evidence: parseEvidence(rootEvidence),
        plan: planBlock != null ? (extractFenced(`\`\`\`\n${planBlock}\n\`\`\``) ?? planBlock) : undefined,
        videoUrl,
        finalScreenshotUrl,
    };
}

function parseSuggested(body: string): InvestigationSuggestedTest[] {
    const out: InvestigationSuggestedTest[] = [];
    for (const chunk of body.split(/\n(?=### )/)) {
        const name = chunk.match(/^###\s+(.+)$/m)?.[1];
        if (name == null) continue;
        const reasoning =
            chunk
                .slice(chunk.indexOf(name) + name.length)
                .split("\n")
                .map((l) => l.trim())
                .find((l) => l !== "") ?? "";
        const instruction = blockBetween(chunk, "<summary>Proposed plan</summary>", ["</details>"]) ?? "";
        out.push({ name, reasoning, instruction: extractFenced(`\n${instruction}\n`) ?? instruction });
    }
    return out;
}

/**
 * Split the report into top-level sections at `## ` headings, but ONLY when not inside a ``` code fence.
 * The rendered test plans and suggested-test blocks are fenced and contain their OWN `## Setup` / `## Steps`
 * / `## What` headers - a naive line split would mistake those for findings (that was the "unknown" artifact
 * bug). Fence-aware splitting keeps each finding's full body (including its fenced plan) intact.
 */
function splitTopLevelSections(markdown: string): Array<{ heading: string; body: string }> {
    const sections: Array<{ heading: string; body: string }> = [];
    let inFence = false;
    let heading: string | undefined;
    let bodyLines: string[] = [];
    for (const line of markdown.split("\n")) {
        if (line.startsWith("```")) inFence = !inFence;
        const match = inFence ? null : /^##\s+(.*)$/.exec(line);
        if (match != null) {
            if (heading != null) sections.push({ heading, body: bodyLines.join("\n") });
            heading = (match[1] ?? "").trim();
            bodyLines = [];
        } else if (heading != null) {
            bodyLines.push(line);
        }
    }
    if (heading != null) sections.push({ heading, body: bodyLines.join("\n") });
    return sections;
}

export function parseReportMarkdown(markdown: string): InvestigationReportData {
    const header = markdown.match(HEADER_RE);
    const client = header?.[1] ?? "";
    const prNumber = header?.[2] != null ? Number.parseInt(header[2], 10) : 0;
    const appSlug = header?.[3] ?? "";

    const findings: InvestigationFinding[] = [];
    const suggested: InvestigationSuggestedTest[] = [];
    const slugCounts = new Map<string, number>();

    for (const { heading, body } of splitTopLevelSections(markdown)) {
        if (heading === "Proposed new tests") {
            suggested.push(...parseSuggested(body));
            continue;
        }
        // Anchor on the reliable markers the renderer always emits: a section is a finding ONLY if it carries
        // a verdict line, or is a classification error. Stray headings that slip through are skipped, never
        // invented as "unknown" findings.
        const isClassificationError = /-\s*classification error$/.test(heading);
        const verdictSlug = body.match(VERDICT_RE)?.[1];
        if (!isClassificationError && verdictSlug == null) continue;
        // Dedup by the real slug (verdict line, or heading for a classification error), not the headline.
        const baseSlug = heading.match(/^(.*?)\s*-\s*classification error$/)?.[1] ?? verdictSlug ?? heading;
        const seen = (slugCounts.get(baseSlug) ?? 0) + 1;
        slugCounts.set(baseSlug, seen);
        findings.push(parseFinding(seen === 1 ? baseSlug : `${baseSlug}-${seen}`, heading, body));
    }

    const prTitle = markdown.match(/^\*\*PR #\d+:\*\*\s+(.+)$/m)?.[1];
    const prBody = blockBetween(markdown, "<summary>PR description</summary>", ["</details>"]);
    const deployedRaw = markdown.slice(markdown.indexOf("<summary>Deployed agent (k8s) comparison</summary>"));
    const deployed = deployedRaw.includes("Deployed agent")
        ? {
              found: !deployedRaw.includes("No run found"),
              jobStatus: deployedRaw.match(/- \*\*job status:\*\*\s+(.+)/)?.[1],
              analysisReasoning: blockBetween(deployedRaw, "- **analysis:**", ["</details>"]),
              perTest: [],
          }
        : undefined;

    return { client, appSlug, prNumber, prTitle, prBody, findings, suggested, deployed };
}
