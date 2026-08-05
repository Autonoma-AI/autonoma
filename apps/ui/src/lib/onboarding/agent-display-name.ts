/**
 * A friendly name for the coding agent driving an onboarding session, from the
 * `clientInfo` it reported over MCP.
 *
 * The client-reported name varies ("claude-code", "cursor", "Windsurf", ...), so we
 * match the ones we know and fall back to a neutral label. Never assume Claude: the
 * name goes into sentences the user reads as fact ("Cursor is finishing this setup"),
 * and naming the wrong tool reads as the product not knowing what it is talking to.
 */
export function agentDisplayName(client?: string): string {
    if (client == null) return "Your coding agent";
    const normalized = client.toLowerCase();
    if (normalized.includes("claude")) return "Claude";
    if (normalized.includes("cursor")) return "Cursor";
    if (normalized.includes("codex") || normalized.includes("openai")) return "Codex";
    if (normalized.includes("windsurf")) return "Windsurf";
    if (normalized.includes("cline")) return "Cline";
    if (normalized.includes("copilot")) return "Copilot";
    return "Your coding agent";
}
