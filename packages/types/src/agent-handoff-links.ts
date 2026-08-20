/**
 * The coding-agent handoff's URL plumbing, shared by every surface that offers one - the GitHub
 * comments (investigation, analysis) and the in-app failure notes. The encoding rules here are
 * vendor quirks discovered the hard way, so they live in exactly one place rather than being
 * re-derived per surface.
 */

/** One "open in <agent>" deep-link: a label and the prefilled URL behind it. */
export interface AgentHandoffLink {
    /** The full call to action ("Open in Cursor"). */
    label: string;
    /** The agent's name alone, for a surface that supplies its own verb ("Send to: [Cursor]"). */
    name: string;
    href: string;
}

/**
 * The handoff prompt is capped so it can never blow GitHub's ~64KB comment limit; overflow points the reader at
 * the full in-app report instead. The same (capped) prompt feeds both the copy block and the deep-links.
 */
export const MAX_HANDOFF_PROMPT_CHARS = 20_000;

/**
 * The "open in <agent>" deep-links, each carrying the SAME full prompt as the copy block rather than a short
 * kickoff - the agent should open with the whole context. Big prompts make long URLs: Claude Code accepts them
 * (~14k chars), while Cursor truncates very large ones at its URL limit, so the copy block stays the reliable
 * full source. None auto-run; each opens the agent prefilled for the developer to review and send.
 *
 * Codex is a `codex://` scheme rather than an https URL: it opens the locally installed app, and does nothing at
 * all when there isn't one - so every other entry here is a web link, and one of them (ChatGPT) needs nothing
 * installed at all. A reader who has no agent set up still has somewhere to send the brief.
 *
 * `repoFullName` is optional: it only pre-selects the repository for Claude Code, and some surfaces (a Vercel
 * deployment, which Autonoma knows by deployment id) have no repo to name.
 */
export function buildAgentHandoffLinks(prompt: string, repoFullName?: string): AgentHandoffLink[] {
    const encoded = encodeQueryParam(prompt);
    // Cursor's deep-link truncates the text param at the first "&" (even percent-encoded), so strip it.
    const cursorText = encodeQueryParam(prompt.replaceAll("&", "and"));
    const repositories = repoFullName != null ? `&repositories=${encodeQueryParam(repoFullName)}` : "";
    return [
        {
            name: "Claude Code",
            label: "Open in Claude Code",
            href: `https://claude.ai/code?prompt=${encoded}${repositories}`,
        },
        { name: "ChatGPT", label: "Open in ChatGPT", href: `https://chatgpt.com/?q=${encoded}` },
        { name: "Codex", label: "Open in Codex", href: `codex://new?prompt=${encoded}` },
        { name: "Cursor", label: "Open in Cursor", href: `https://cursor.com/link/prompt?text=${cursorText}` },
    ];
}

/**
 * Truncate an over-long prompt, pointing the reader at the full in-app report for the rest.
 *
 * `maxChars` defaults to the GitHub-comment ceiling. A caller writing into a URL rather than a comment body
 * passes its own, much smaller, limit - and should prefer handing in an already-condensed prompt, since this
 * cuts from the TAIL and would otherwise drop whichever findings happen to sort last.
 */
export function capHandoffPrompt(prompt: string, fallbackUrl: string, maxChars = MAX_HANDOFF_PROMPT_CHARS): string {
    if (prompt.length <= maxChars) return prompt;
    return `${prompt.slice(0, maxChars)}\n\n… (truncated) - open the full findings in Autonoma: ${fallbackUrl}`;
}

// encodeURIComponent leaves "(" and ")" unescaped, but an unescaped ")" prematurely closes the markdown link
// destination the deep-link is rendered into - so encode them too.
function encodeQueryParam(value: string): string {
    return encodeURIComponent(value).replaceAll("(", "%28").replaceAll(")", "%29");
}
