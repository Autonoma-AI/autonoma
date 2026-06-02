import { logger as rootLogger } from "@autonoma/logger";
import type { AutonomaCommentBug, AutonomaCommentPayload, AutonomaCommentState } from "./types";

const STATE_LABELS: Record<AutonomaCommentState, string> = {
    running: "RUNNING",
    healthy: "HEALTHY",
    critical: "UNHEALTHY",
    unknown: "UNKNOWN",
};

const STATE_ICONS: Record<AutonomaCommentState, string> = {
    running: "🟡",
    healthy: "🟢",
    critical: "🔴",
    unknown: "⚪",
};

const STATUS_PILL_ASSETS: Record<AutonomaCommentState, string> = {
    running: "status-running-pill.svg",
    healthy: "status-healthy-pill.svg",
    critical: "status-critical-pill.svg",
    unknown: "status-unknown-pill.svg",
};

const STATUS_DOT_ASSETS: Record<AutonomaCommentState, string> = {
    running: "status-dot-yellow.svg",
    healthy: "status-dot-green.svg",
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

    const statusImage = renderStatusImage(payload);
    if (statusImage != null) sections.push("", statusImage);

    const titlePrefix = statusImage == null ? `${STATE_ICONS[payload.state]} ` : "";
    sections.push("", `## ${titlePrefix}${escapeMarkdown(renderTitle(payload))}`, "");

    if (statusImage == null) {
        sections.push(`**${STATE_LABELS[payload.state]}** - ${escapeMarkdown(payload.headline)}`);
    }

    const statsLine = renderStatsLine(payload);
    if (statsLine != null) sections.push("", statsLine);

    if (payload.bugs.length > 0) {
        sections.push("", "**Top issues**", renderBugList(payload));
    }

    if (payload.ctas.length > 0) sections.push("", renderCtas(payload));

    if (payload.commitRef != null && payload.commitRef !== "") {
        sections.push("", `Triggered by commit \`${inlineCodeContent(payload.commitRef)}\``);
    }

    if (payload.services.length > 0) {
        sections.push("", "**Services:**", "", "| Service | Status | URL | Logs |", "|---|---:|---|---|");
        for (const service of payload.services) {
            sections.push(
                `| ${escapeTableCell(service.name)} | ${escapeTableCell(service.status)} | ${renderLinkOrDash(
                    service.url,
                    service.url,
                )} | ${renderLinkOrDash("view", service.logsUrl)} |`,
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
    if (payload.state === "critical" && payload.bugs.length > 0) {
        const count = payload.bugs.length;
        return `Autonoma found ${count} ${count === 1 ? "bug" : "bugs"} in this PR`;
    }
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

    const tests = stats?.selected != null ? String(stats.selected) : "-";
    const duration = payload.duration ?? "-";

    const passRate =
        stats?.selected == null || stats.selected === 0 || stats.passed == null
            ? "-"
            : `${Math.round((stats.passed / stats.selected) * 100)}%`;

    const fields = [`**Tests** \`${tests}\``, `**Pass rate** \`${passRate}\``];
    if (payload.bugs.length > 0) fields.push(`**Bugs** \`${payload.bugs.length}\``);
    if (stats?.failed != null) fields.push(`**Failed** \`${stats.failed}\``);
    fields.push(`**Duration** \`${inlineCodeContent(duration)}\``);

    return fields.join(" &nbsp;&nbsp; ");
}

function renderBugList(payload: AutonomaCommentPayload): string {
    const dotUrl = resolveAssetUrl(payload.assetBaseUrl, STATUS_DOT_ASSETS[payload.state]);
    return payload.bugs
        .slice(0, 3)
        .map((bug) => `${renderBugMarker(dotUrl)} ${renderBugLabel(bug)}${renderBugOccurrence(bug)}`)
        .join("  \n");
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
    return payload.ctas.map((cta) => renderCta(payload.assetBaseUrl, cta.label, cta.href)).join(" | ");
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
