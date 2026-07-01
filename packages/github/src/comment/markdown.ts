import { logger as rootLogger } from "@autonoma/logger";
import type {
    AutonomaCommentBug,
    AutonomaCommentEvidence,
    AutonomaCommentPayload,
    AutonomaCommentState,
    AutonomaCommentStats,
} from "./types";

const STATE_LABELS: Record<AutonomaCommentState, string> = {
    running: "RUNNING",
    healthy: "HEALTHY",
    warning: "WARNING",
    critical: "UNHEALTHY",
    unknown: "UNKNOWN",
};

const STATE_ICONS: Record<AutonomaCommentState, string> = {
    running: "🟡",
    healthy: "🟢",
    warning: "🟡",
    critical: "🔴",
    unknown: "⚪",
};

const STATUS_PILL_ASSETS: Record<AutonomaCommentState, string> = {
    running: "status-running-pill.svg",
    healthy: "status-healthy-pill.svg",
    warning: "status-warning-pill.svg",
    critical: "status-critical-pill.svg",
    unknown: "status-unknown-pill.svg",
};

const STATUS_DOT_ASSETS: Record<AutonomaCommentState, string> = {
    running: "status-dot-yellow.svg",
    healthy: "status-dot-green.svg",
    warning: "status-dot-yellow.svg",
    critical: "status-dot-red.svg",
    unknown: "status-dot-gray.svg",
};

const CTA_ASSETS: Record<string, string> = {
    "Open in Autonoma": "open-in-autonoma-button-v2.svg",
    "See preview": "see-preview-button-v2.svg",
};

const CTA_TEXT_PREFIXES: Record<string, string> = {
    "Open in Autonoma": "↗ ",
    "See preview": "👁 ",
};

export function renderMarkdown(payload: AutonomaCommentPayload): string {
    const sections: string[] = ["<!-- autonoma:pr-comment:v2 -->"];
    const rich = payload.bugs.some(isRichBug);

    const statusImage = renderStatusImage(payload);
    if (statusImage != null) sections.push("", statusImage);

    // The title is generated (no user content), so render it as markdown - the bug/warning count is wrapped in
    // a `code` span to stand out, which escaping would otherwise neutralize.
    const titlePrefix = statusImage == null ? `${STATE_ICONS[payload.state]} ` : "";
    sections.push("", `## ${titlePrefix}${renderTitle(payload)}`, "");

    if (statusImage == null) {
        sections.push(`**${STATE_LABELS[payload.state]}** - ${escapeMarkdown(payload.headline)}`);
    }

    // The stats line + "Top issues" label only add noise to the rich investigation comment (the title already
    // carries the count); keep them for the plain diffs comment only.
    if (!rich) {
        const statsLine = renderStatsLine(payload);
        if (statsLine != null) sections.push("", statsLine);
    }

    if (payload.bugs.length > 0) {
        sections.push("", ...(rich ? [] : ["**Top issues**"]), renderBugList(payload));
    }

    if (payload.ctas.length > 0) sections.push("", renderCtas(payload));

    if (payload.commitRef != null && payload.commitRef !== "") {
        sections.push("", `Triggered by commit \`${inlineCodeContent(payload.commitRef)}\``);
    }

    if (payload.services.length > 0) {
        sections.push("", "**Services:**", "", "| Service | Status | URL |", "|---|---:|---|");
        for (const service of payload.services) {
            sections.push(
                `| ${escapeTableCell(service.name)} | ${escapeTableCell(service.status)} | ${renderLinkOrDash(
                    service.url,
                    service.url,
                )} |`,
            );
        }
    }

    if (payload.addons.length > 0) {
        sections.push("", "**Addons:**");
        for (const addon of payload.addons) {
            const status = addon.status === "ready" ? "Ready" : "Failed";
            sections.push(`- ${escapeMarkdown(addon.name)} (${escapeMarkdown(addon.provider)}) - ${status}`);
        }
    }

    if (payload.warnings.length > 0) {
        sections.push("", "> **Note:**", ...payload.warnings.map((warning) => `> - ${escapeMarkdown(warning)}`));
    }

    for (const detail of payload.details) {
        const fence = "`".repeat(longestBacktickRun(detail.body) + 1);
        sections.push(
            "",
            "<details>",
            `<summary>${escapeHtml(detail.summary)}</summary>`,
            "",
            fence,
            detail.body,
            fence,
            "</details>",
        );
    }

    return sections.join("\n");
}

function renderTitle(payload: AutonomaCommentPayload): string {
    const count = payload.bugs.length;
    const rich = payload.bugs.some(isRichBug);
    // The rich investigation comment highlights the count and uses friendlier warning/healthy titles; the plain
    // diffs comment keeps its existing titles unchanged.
    if (payload.state === "critical" && count > 0) {
        const label = `${count} ${count === 1 ? "bug" : "bugs"}`;
        return `Autonoma found ${rich ? `\`${label}\`` : label} in this PR`;
    }
    if (rich && payload.state === "warning" && count > 0) {
        return `Autonoma raised \`${count} ${count === 1 ? "warning" : "warnings"}\` in this PR`;
    }
    if (rich && payload.state === "healthy") return "Autonoma found no issues in this PR";
    return `Autonoma PR #${payload.prNumber}`;
}

function renderStatusImage(payload: AutonomaCommentPayload): string | undefined {
    const assetUrl = resolveAssetUrl(payload.assetBaseUrl, STATUS_PILL_ASSETS[payload.state]);
    if (assetUrl == null) return undefined;
    return `<img src="${escapeHtmlAttribute(assetUrl)}" alt="${escapeHtmlAttribute(STATE_LABELS[payload.state])}" width="126" />`;
}

function renderStatsLine(payload: AutonomaCommentPayload): string | undefined {
    const stats = payload.stats;
    if (stats == null && payload.duration == null && payload.bugs.length === 0) return undefined;

    // Fields mirror the in-app checkpoint row order (failed, setup-failed,
    // running/awaiting-review, passed, bugs) so the comment reads the same as the
    // UI for the same snapshot.
    const fields = [`**Tests** \`${testsCount(stats)}\``];

    if (stats != null) {
        if (stats.failed != null && stats.failed > 0) fields.push(`**Failed** \`${stats.failed}\``);
        if (stats.setupFailed != null && stats.setupFailed > 0)
            fields.push(`**Setup failed** \`${stats.setupFailed}\``);
        if (stats.running != null && stats.running > 0)
            fields.push(`**${titleCase(stats.runningLabel ?? "running")}** \`${stats.running}\``);
        if (stats.passed != null && stats.passed > 0) fields.push(`**Passed** \`${stats.passed}\``);
    }
    if (payload.bugs.length > 0) fields.push(`**Bugs** \`${payload.bugs.length}\``);

    fields.push(`**Pass rate** \`${passRate(stats)}\``);
    fields.push(`**Duration** \`${inlineCodeContent(payload.duration ?? "-")}\``);

    return fields.join(" &nbsp;&nbsp; ");
}

function testsCount(stats: AutonomaCommentStats | undefined): string {
    if (stats?.assigned != null) return String(stats.assigned);
    if (stats?.selected != null) return String(stats.selected);
    return "-";
}

// Pass rate over the tests that reached a terminal pass/fail, so a not-run or
// in-flight checkpoint shows "-" instead of a misleading 0%.
function passRate(stats: AutonomaCommentStats | undefined): string {
    const passed = stats?.passed;
    if (passed == null) return "-";
    const completed = passed + (stats?.failed ?? 0);
    if (completed === 0) return "-";
    return `${Math.round((passed / completed) * 100)}%`;
}

function titleCase(value: string): string {
    if (value.length === 0) return value;
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderBugList(payload: AutonomaCommentPayload): string {
    const dotUrl = resolveAssetUrl(payload.assetBaseUrl, STATUS_DOT_ASSETS[payload.state]);
    // Rich bugs (the investigation comment) each expand into a <details> with screenshot + remediation +
    // nested evidence; the diffs comment's plain bugs stay one-liners (top 3) - fully backward-compatible.
    if (payload.bugs.some(isRichBug)) {
        return payload.bugs.map((bug) => renderBugDetails(bug, dotUrl)).join("\n");
    }
    return payload.bugs
        .slice(0, 3)
        .map((bug) => `${renderBugMarker(dotUrl)} ${renderBugLabel(bug)}${renderBugOccurrence(bug)}`)
        .join("  \n");
}

function isRichBug(bug: AutonomaCommentBug): boolean {
    return (
        bug.description != null ||
        bug.screenshotUrl != null ||
        bug.remediation != null ||
        (bug.evidence != null && bug.evidence.length > 0)
    );
}

/** One bug as an expandable section: collapsed it's a one-line title; expanded it shows the evidence. */
function renderBugDetails(bug: AutonomaCommentBug, dotUrl: string | undefined): string {
    const occurrence = bug.occurrenceCount != null ? ` <code>×${bug.occurrenceCount}</code>` : "";
    const summary = `${renderBugMarker(dotUrl)} ${escapeHtml(bug.title)}${occurrence}`;
    const body: string[] = [];

    if (bug.screenshotUrl != null) {
        const img = `<img src="${escapeHtmlAttribute(bug.screenshotUrl)}" alt="Run screenshot" />`;
        body.push(bug.replayHref != null ? `<a href="${escapeHtmlAttribute(bug.replayHref)}">${img}</a>` : img);
    }
    if (bug.replayHref != null) body.push(`🎬 [Watch replay](${escapeUrl(bug.replayHref)})`);
    if (bug.description != null) body.push(sanitizeRichMarkdown(bug.description));
    if (bug.remediation != null) body.push(`**Remediation:** ${sanitizeRichMarkdown(bug.remediation)}`);
    if (bug.evidence != null && bug.evidence.length > 0) body.push(renderEvidence(bug.evidence));

    const links = renderBugLinks(bug);
    if (links !== "") body.push(links);

    return ["<details>", `<summary>${summary}</summary>`, "", body.join("\n\n"), "</details>"].join("\n");
}

/**
 * The nested Evidence collapsible - the full picture a coding agent needs. Each item is a labelled line (source
 * + file:line + detail) followed by its code snippet in its own fenced, syntax-highlighted block - rendered as
 * real markdown rather than one monospace blob.
 */
function renderEvidence(items: AutonomaCommentEvidence[]): string {
    const lines: string[] = ["<details>", "<summary>Evidence</summary>", ""];
    for (const item of items) {
        const location =
            item.file != null
                ? ` \`${inlineCodeContent(`${item.file}${item.lines != null ? `:${item.lines}` : ""}`)}\``
                : "";
        const detail = item.detail != null && item.detail !== "" ? ` - ${sanitizeRichMarkdown(item.detail)}` : "";
        lines.push(`**[${escapeMarkdown(item.source)}]**${location}${detail}`);
        if (item.snippet != null && item.snippet !== "") {
            const fence = "`".repeat(longestBacktickRun(item.snippet) + 1);
            lines.push("", `${fence}${languageForFile(item.source, item.file)}`, item.snippet, fence);
        }
        lines.push("");
    }
    lines.push("</details>");
    return lines.join("\n");
}

/** A fence language for syntax highlighting, from the evidence source (a diff) or the file extension. */
function languageForFile(source: string, file: string | undefined): string {
    if (source === "diff") return "diff";
    const ext = file?.split(".").pop()?.toLowerCase();
    const byExt: Record<string, string> = {
        ts: "ts",
        tsx: "tsx",
        js: "js",
        jsx: "jsx",
        py: "python",
        rb: "ruby",
        go: "go",
        rs: "rust",
        java: "java",
        sql: "sql",
        json: "json",
        sh: "bash",
        css: "css",
        html: "html",
    };
    return ext != null ? (byExt[ext] ?? "") : "";
}

function renderBugLinks(bug: AutonomaCommentBug): string {
    const links: string[] = [];
    if (bug.href != null) links.push(`[See full report](${escapeUrl(bug.href)})`);
    if (bug.previewHref != null) links.push(`[Open preview](${escapeUrl(bug.previewHref)})`);
    return links.join(" · ");
}

/**
 * Render LLM-authored prose as markdown (so `code` spans and file:line survive) while neutralizing the only
 * tags that could break the comment's <details> structure. GitHub's own sanitizer strips scripts/unsafe HTML.
 */
function sanitizeRichMarkdown(value: string): string {
    return value.replace(/<(\/?)(details|summary)\b/gi, "&lt;$1$2");
}

function renderBugMarker(dotUrl: string | undefined): string {
    if (dotUrl == null) return STATE_ICONS.critical;
    return `<img src="${escapeHtmlAttribute(dotUrl)}" width="12" height="12" alt="" />`;
}

function renderBugLabel(bug: AutonomaCommentBug): string {
    if (bug.href == null) return escapeMarkdown(bug.title);
    return `[${escapeLinkLabel(bug.title)}](${escapeUrl(bug.href)})`;
}

function renderBugOccurrence(bug: AutonomaCommentBug): string {
    if (bug.occurrenceCount == null) return "";
    return ` \`x${bug.occurrenceCount}\``;
}

function renderCtas(payload: AutonomaCommentPayload): string {
    const rendered = payload.ctas.map((cta) => renderCta(payload.assetBaseUrl, cta.label, cta.href));
    // Button images sit fine side by side; the " | " separator only helps the text-link fallback.
    const hasAssets = payload.assetBaseUrl != null && payload.assetBaseUrl !== "";
    return rendered.join(hasAssets ? "&nbsp;&nbsp;" : " | ");
}

function renderCta(assetBaseUrl: string | undefined, label: string, href: string): string {
    const assetUrl = resolveAssetUrl(assetBaseUrl, CTA_ASSETS[label]);
    if (assetUrl != null) {
        return `<a href="${escapeHtmlAttribute(href)}"><img src="${escapeHtmlAttribute(assetUrl)}" alt="${escapeHtmlAttribute(label)}" width="150" /></a>`;
    }
    const displayLabel = `${CTA_TEXT_PREFIXES[label] ?? ""}${label}`;
    return `[${escapeLinkLabel(displayLabel)}](${escapeUrl(href)})`;
}

function resolveAssetUrl(baseUrl: string | undefined, file: string | undefined): string | undefined {
    if (baseUrl == null || baseUrl === "" || file == null) return undefined;
    const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    try {
        return new URL(file, normalizedBase).toString();
    } catch (err) {
        rootLogger.child({ name: "resolveAssetUrl" }).warn("Invalid asset base URL", { baseUrl, file, err });
        return undefined;
    }
}

function renderLinkOrDash(label: string | undefined, href: string | undefined): string {
    if (label == null || label === "" || href == null || href === "") return "-";
    return `[${escapeLinkLabel(label)}](${escapeUrl(href)})`;
}

function longestBacktickRun(value: string): number {
    let longest = 0;
    for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    return Math.max(3, longest);
}

function escapeMarkdown(value: string): string {
    return escapeHtmlText(value)
        .replaceAll("\\", "\\\\")
        .replaceAll("*", "\\*")
        .replaceAll("_", "\\_")
        .replaceAll("`", "\\`");
}

function escapeTableCell(value: string): string {
    return escapeMarkdown(value).replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function escapeLinkLabel(value: string): string {
    return escapeMarkdown(value).replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeUrl(value: string): string {
    return value.replaceAll(")", "%29").replace(/\s/g, "%20");
}

// Backticks inside an inline `code` span would close it prematurely. The only
// callers are commit SHAs, stats numbers, and durations - none should contain
// backticks - but be defensive and substitute U+02CB (modifier letter grave
// accent) so we never produce a half-open span.
function inlineCodeContent(value: string): string {
    return value.replaceAll("`", "ˋ");
}

function escapeHtml(value: string): string {
    return escapeHtmlText(value).replaceAll('"', "&quot;");
}

function escapeHtmlAttribute(value: string): string {
    return escapeHtml(value).replaceAll("'", "&#39;");
}

function escapeHtmlText(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
