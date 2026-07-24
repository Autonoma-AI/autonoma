import type { AutonomaCommentCta } from "./types";

/**
 * The coding-agent handoff's URL plumbing, shared by every comment that offers one (investigation, analysis). The
 * encoding rules here are vendor quirks discovered the hard way, so they live in exactly one place rather than
 * being re-derived per comment kind.
 */

/**
 * The handoff prompt is capped so it can never blow GitHub's ~64KB comment limit; overflow points the reader at
 * the full in-app report instead. The same (capped) prompt feeds both the copy block and the deep-links.
 */
export const MAX_HANDOFF_PROMPT_CHARS = 20_000;

/**
 * The "open in <agent>" deep-links, each carrying the SAME full prompt as the copy block rather than a short
 * kickoff - the agent should open with the whole context. Big prompts make long URLs: Claude Code accepts them
 * (~14k chars), while Cursor/ChatGPT truncate very large ones at their URL limits, so the copy block stays the
 * reliable full source. None auto-run; each opens the agent prefilled for the developer to review and send.
 */
export function buildAgentHandoffLinks(prompt: string, repoFullName: string): AutonomaCommentCta[] {
    const encoded = encodeQueryParam(prompt);
    // Cursor's deep-link truncates the text param at the first "&" (even percent-encoded), so strip it.
    const cursorText = encodeQueryParam(prompt.replaceAll("&", "and"));
    return [
        {
            label: "Open in Claude Code",
            href: `https://claude.ai/code?prompt=${encoded}&repositories=${encodeQueryParam(repoFullName)}`,
        },
        { label: "Open in ChatGPT", href: `https://chatgpt.com/?q=${encoded}` },
        { label: "Open in Cursor", href: `https://cursor.com/link/prompt?text=${cursorText}` },
    ];
}

/** Truncate an over-long prompt, pointing the reader at the full in-app report for the rest. */
export function capHandoffPrompt(prompt: string, fallbackUrl: string): string {
    if (prompt.length <= MAX_HANDOFF_PROMPT_CHARS) return prompt;
    return `${prompt.slice(0, MAX_HANDOFF_PROMPT_CHARS)}\n\n… (truncated) - open the full findings in Autonoma: ${fallbackUrl}`;
}

// encodeURIComponent leaves "(" and ")" unescaped, but an unescaped ")" prematurely closes the markdown link
// destination the deep-link is rendered into - so encode them too.
function encodeQueryParam(value: string): string {
    return encodeURIComponent(value).replaceAll("(", "%28").replaceAll(")", "%29");
}
