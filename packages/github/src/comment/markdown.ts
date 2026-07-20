import { logger as rootLogger } from "@autonoma/logger";
import type {
    AutonomaCommentBug,
    AutonomaCommentEvidence,
    AutonomaCommentHandoff,
    AutonomaCommentPayload,
    AutonomaCommentState,
    AutonomaCommentStats,
} from "./types";

const HANDOFF_SUMMARY = "🤖 Hand off to a coding agent";

const STATE_LABELS: Record<AutonomaCommentState, string> = {
    running: "RUNNING",
    healthy: "HEALTHY",
    incomplete: "NOT FULLY TESTED",
    warning: "WARNING",
    critical: "UNHEALTHY",
    unknown: "UNKNOWN",
};

const STATE_ICONS: Record<AutonomaCommentState, string> = {
    running: "🟡",
    healthy: "🟢",
    incomplete: "⚪",
    warning: "🟡",
    critical: "🔴",
    unknown: "⚪",
};

// The "See preview" CTA links to the live preview environment. Exported so the teardown path
// (which removes it once the environment is gone) keys off the same label instead of a private copy.
export const SEE_PREVIEW_CTA_LABEL = "See preview";

// The comment is text-first (portable to markdown-only renderers like Linear): most CTAs are plain
// markdown links. The two top-level CTAs keep an image (a Vercel-style primary + secondary pair) rendered
// as a markdown image-link that still degrades to a plain link where images are stripped.
// The version suffix cache-busts GitHub's camo image proxy, which caches by source URL: any visual
// change to a button must ship under a new filename (keep the old file so existing comments still render).
const CTA_ASSETS: Record<string, string> = {
    "Open in Autonoma": "open-in-autonoma-button-v3.svg",
    [SEE_PREVIEW_CTA_LABEL]: "see-preview-button-v3.svg",
};

const CTA_TEXT_PREFIXES: Record<string, string> = {
    "Open in Autonoma": "↗ ",
    [SEE_PREVIEW_CTA_LABEL]: "👁 ",
    "Watch replay": "🎬 ",
    "See full report": "📄 ",
    "Open preview": "👁 ",
};

export function renderMarkdown(payload: AutonomaCommentPayload): string {
    const sections: string[] = ["<!-- autonoma:pr-comment:v2 -->"];
    const rich = payload.bugs.some(isRichBug);

    // Text-first: a status emoji + generated title, then the state label + headline as plain markdown - no
    // status-pill image, so a markdown-only renderer still shows the state. The bug/warning count in the title
    // is wrapped in a `code` span to stand out, which escaping would otherwise neutralize.
    sections.push("", `## ${STATE_ICONS[payload.state]} ${renderTitle(payload)}`, "");
    sections.push(`**${STATE_LABELS[payload.state]}** - ${escapeMarkdown(payload.headline)}`);

    // The run-level narration (analysis comment) sits right under the headline as a prose paragraph. It is
    // LLM-authored, so it is sanitized the same way rich bug prose is.
    if (payload.summary != null && payload.summary !== "") {
        sections.push("", sanitizeRichMarkdown(payload.summary));
    }

    // The stats line mirrors the in-app checkpoint row; show it on every comment that carries test stats,
    // rich or not, so the comment reads the same as the dashboard for the same snapshot.
    if (payload.stats != null) {
        const statsLine = renderStatsLine(payload);
        if (statsLine != null) sections.push("", statsLine);
    }

    if (payload.bugs.length > 0) {
        // Rich bugs each expand into their own <details>; the plain comment groups its one-liners under a label.
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

    if (payload.handoff != null) sections.push("", renderHandoff(payload.handoff));

    return sections.join("\n");
}

/**
 * The "hand off to a coding agent" collapsible: "open in <agent>" deep-links (prefill only) plus the full
 * paste-ready prompt in a code fence, which GitHub renders with a native copy button. The outer fence is sized
 * longer than any backtick run in the prompt so the evidence's own code blocks survive intact.
 */
function renderHandoff(handoff: AutonomaCommentHandoff): string {
    const lines: string[] = ["<details>", `<summary>${HANDOFF_SUMMARY}</summary>`, ""];
    if (handoff.links.length > 0) {
        lines.push("Open with your coding agent - the prompt is prefilled (review, then send):", "");
        lines.push(handoff.links.map((link) => renderTextLink(link.label, link.href)).join(" · "));
        lines.push("", "Or copy the full prompt below:", "");
    }
    const fence = "`".repeat(longestBacktickRun(handoff.prompt) + 1);
    lines.push(fence, handoff.prompt, fence, "</details>");
    return lines.join("\n");
}

function renderTitle(payload: AutonomaCommentPayload): string {
    const counts = countByMarker(payload.bugs);
    const rich = payload.bugs.some(isRichBug);
    // The rich investigation comment highlights the count and uses friendlier warning/healthy titles; the plain
    // preview comment (no findings) falls through to the generic PR title. Counts are per-severity (a client bug
    // is a "bug", an actionable issue a "warning", an engine artifact an "engine issue") so a mixed run reads right.
    if (payload.state === "critical" && counts.bugs > 0) {
        const label = `${counts.bugs} ${counts.bugs === 1 ? "bug" : "bugs"}`;
        return `Autonoma found ${rich ? `\`${label}\`` : label} in this PR`;
    }
    if (rich && payload.state === "warning" && counts.warnings > 0) {
        return `Autonoma raised \`${counts.warnings} ${counts.warnings === 1 ? "warning" : "warnings"}\` in this PR`;
    }
    // Only engine artifacts surfaced: the flows never ran, so we can't claim "no issues" - we didn't finish testing.
    if (payload.state === "incomplete") return "Autonoma couldn't fully test this PR";
    if (rich && payload.state === "healthy") return "Autonoma found no issues in this PR";
    return `Autonoma PR #${payload.prNumber}`;
}

/**
 * Group the bug rows by the severity each carries in its own `markerState`, into the three buckets the comment
 * counts and colors: client bugs, actionable warnings, and engine artifacts. A bug with no `markerState` (the
 * diffs comment's plain bugs) counts as a bug, preserving that comment's existing "Bugs N" line unchanged.
 */
function countByMarker(bugs: AutonomaCommentBug[]): { bugs: number; warnings: number; engine: number } {
    let bugCount = 0;
    let warnings = 0;
    let engine = 0;
    for (const bug of bugs) {
        if (bug.markerState === "warning") warnings += 1;
        else if (bug.markerState === "incomplete") engine += 1;
        else bugCount += 1;
    }
    return { bugs: bugCount, warnings, engine };
}

function renderStatsLine(payload: AutonomaCommentPayload): string | undefined {
    const stats = payload.stats;

    // Fields mirror the in-app checkpoint row order (tests, failed, setup-failed, running/awaiting-review,
    // passed, bugs, pass rate, duration). Each is omitted when it has no value - never render a bare "-".
    const fields: string[] = [];

    const tests = testsCount(stats);
    if (tests !== "-") fields.push(`**Tests** \`${tests}\``);

    if (stats != null) {
        if (stats.failed != null && stats.failed > 0) fields.push(`**Failed** \`${stats.failed}\``);
        if (stats.setupFailed != null && stats.setupFailed > 0)
            fields.push(`**Setup failed** \`${stats.setupFailed}\``);
        if (stats.running != null && stats.running > 0)
            fields.push(`**${titleCase(stats.runningLabel ?? "running")}** \`${stats.running}\``);
        if (stats.passed != null && stats.passed > 0) fields.push(`**Passed** \`${stats.passed}\``);
    }
    // Split by severity so engine artifacts (the runner never ran the flow) are not miscounted as bugs.
    const counts = countByMarker(payload.bugs);
    if (counts.bugs > 0) fields.push(`**Bugs** \`${counts.bugs}\``);
    if (counts.warnings > 0) fields.push(`**Warnings** \`${counts.warnings}\``);
    if (counts.engine > 0) fields.push(`**Engine issues** \`${counts.engine}\``);

    const rate = passRate(stats);
    if (rate !== "-") fields.push(`**Pass rate** \`${rate}\``);
    if (payload.duration != null && payload.duration !== "")
        fields.push(`**Duration** \`${inlineCodeContent(payload.duration)}\``);

    if (fields.length === 0) return undefined;
    // A plain " · " (not an HTML entity) so markdown-only renderers show a real separator, not "&nbsp;".
    return fields.join(" · ");
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
    // Rich bugs (the investigation comment) each expand into a <details> with screenshot + remediation +
    // nested evidence; the diffs comment's plain bugs stay one-liners (top 3) - fully backward-compatible.
    if (payload.bugs.some(isRichBug)) {
        return payload.bugs.map((bug) => renderBugDetails(bug, payload.state, payload.assetBaseUrl)).join("\n");
    }
    return payload.bugs
        .slice(0, 3)
        .map((bug) => `${renderBugMarker(bug, payload.state)} ${renderBugLabel(bug)}${renderBugOccurrence(bug)}`)
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
function renderBugDetails(
    bug: AutonomaCommentBug,
    state: AutonomaCommentState,
    assetBaseUrl: string | undefined,
): string {
    const occurrence = bug.occurrenceCount != null ? ` <code>×${bug.occurrenceCount}</code>` : "";
    const summary = `${renderBugMarker(bug, state)} ${escapeHtml(bug.title)}${occurrence}`;
    const body: string[] = [];

    if (bug.screenshotUrl != null) {
        // A markdown image-link: portable to markdown-only renderers (Linear shows the image, or its alt text
        // if images are stripped), and still clickable on GitHub. The screenshot/GIF clicks through to the
        // replay when one exists, else to the finding's report page.
        const img = `![Run screenshot](${linkDestination(bug.screenshotUrl)})`;
        const mediaHref = bug.replayHref ?? bug.href;
        body.push(mediaHref != null ? `[${img}](${linkDestination(mediaHref)})` : img);
    }
    if (bug.replayHref != null) body.push(renderCta(assetBaseUrl, "Watch replay", bug.replayHref));
    if (bug.description != null) body.push(sanitizeRichMarkdown(bug.description));
    if (bug.remediation != null) body.push(`**Remediation:** ${sanitizeRichMarkdown(bug.remediation)}`);
    if (bug.evidence != null && bug.evidence.length > 0) body.push(renderEvidence(bug.evidence));

    const links = renderBugLinks(bug, assetBaseUrl);
    if (links !== "") body.push(links);

    return ["<details>", `<summary>${summary}</summary>`, "", body.join("\n\n"), "</details>"].join("\n");
}

/**
 * The nested Evidence collapsible - the full picture a coding agent needs. Each item is a labelled line (source
 * + file:line + detail) followed by its code snippet in its own fenced, syntax-highlighted block - rendered as
 * real markdown rather than one monospace blob.
 */
function renderEvidence(items: AutonomaCommentEvidence[]): string {
    // Bold (not GitHub's faint default triangle text) so the section - which carries the code evidence - stands
    // out. An <img> chip here would hijack the click to open the image instead of toggling the <details>.
    const lines: string[] = ["<details>", "<summary><strong>Evidence</strong></summary>", ""];
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

function renderBugLinks(bug: AutonomaCommentBug, assetBaseUrl: string | undefined): string {
    const buttons: string[] = [];
    if (bug.href != null) buttons.push(renderCta(assetBaseUrl, "See full report", bug.href));
    if (bug.previewHref != null) buttons.push(renderCta(assetBaseUrl, "Open preview", bug.previewHref));
    return buttons.join(" · ");
}

/**
 * Render LLM-authored prose as markdown (so `code` spans and file:line survive) while neutralizing the only
 * tags that could break the comment's <details> structure. GitHub's own sanitizer strips scripts/unsafe HTML.
 */
function sanitizeRichMarkdown(value: string): string {
    return value.replace(/<(\/?)(details|summary)\b/gi, "&lt;$1$2");
}

// A colored-dot emoji, never an <img>: an image marker sitting inside a <summary> (or next to a
// bug link) hijacks the click and opens the SVG in a new tab instead of toggling the <details> the
// user meant to expand - the same reason the Evidence summary uses bold text over an image chip.
// Each row is colored by its own severity (`markerState`); a plain diffs-comment bug (no marker)
// falls back to the comment's overall state.
function renderBugMarker(bug: AutonomaCommentBug, state: AutonomaCommentState): string {
    return STATE_ICONS[bug.markerState ?? state];
}

function renderBugLabel(bug: AutonomaCommentBug): string {
    if (bug.href == null) return escapeMarkdown(bug.title);
    return renderTextLink(bug.title, bug.href);
}

function renderBugOccurrence(bug: AutonomaCommentBug): string {
    if (bug.occurrenceCount == null) return "";
    return ` \`x${bug.occurrenceCount}\``;
}

function renderCtas(payload: AutonomaCommentPayload): string {
    const rendered = payload.ctas.map((cta) => renderCta(payload.assetBaseUrl, cta.label, cta.href));
    // A plain " · " (not "&nbsp;" or " | ") so markdown-only renderers show a real separator.
    return rendered.join(" · ");
}

/**
 * A CTA. The two top-level CTAs with image assets ("Open in Autonoma" and "See preview") render as a markdown
 * image-link (so it degrades to a plain link where images/HTML are stripped); every other CTA renders as a
 * plain markdown link with its emoji prefix.
 */
function renderCta(assetBaseUrl: string | undefined, label: string, href: string): string {
    const assetUrl = resolveAssetUrl(assetBaseUrl, CTA_ASSETS[label]);
    if (assetUrl != null) {
        return `[![${escapeLinkLabel(label)}](${linkDestination(assetUrl)})](${linkDestination(href)})`;
    }
    const displayLabel = `${CTA_TEXT_PREFIXES[label] ?? ""}${label}`;
    return renderTextLink(displayLabel, href);
}

/** A plain markdown link. Label content stays markdown-escaped so an LLM-authored title with
 * `*`/`_`/backticks/brackets renders literally, not as emphasis or a broken link. */
function renderTextLink(label: string, href: string): string {
    return `[${escapeLinkLabel(label)}](${linkDestination(href)})`;
}

/**
 * A markdown link/image destination wrapped in angle brackets, so a URL with a space or unbalanced
 * parenthesis (e.g. a signed media URL) can't prematurely close the `(...)` and break the link. Angle
 * brackets are stripped by the parser, so the emitted `href`/`src` is the URL unchanged; a literal `<`/`>`
 * (never valid in a URL) is percent-encoded so it can't close the destination.
 */
function linkDestination(href: string): string {
    return `<${href.replaceAll("<", "%3C").replaceAll(">", "%3E")}>`;
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
    return renderTextLink(label, href);
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

function escapeHtmlText(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
