/**
 * Cap `text` to `budget` characters, keeping the head and tail and replacing the elided middle with an
 * explanatory marker. Returns the input unchanged when it already fits.
 *
 * This is the one output-bounding primitive the agent tools share. Each tool declares its own
 * module-level budget and advertises it in its description; accumulation across steps is the loop
 * compactor's job, not this function's. `narrowHint` is appended to the marker verbatim so the tool that
 * overflowed tells the model, in its own words, how to ask for less - the model reads the hint at the
 * exact moment it needs it, rather than having to remember the tool description.
 */
export function truncateOutput(text: string, budget: number, label: string, narrowHint?: string): string {
    if (text.length <= budget) return text;
    const headChars = Math.floor(budget * 0.7);
    const tailChars = budget - headChars;
    const head = text.slice(0, headChars);
    const tail = text.slice(text.length - tailChars);
    const elided = text.length - headChars - tailChars;
    const hint = narrowHint != null ? ` ${narrowHint}` : "";
    const marker = `\n\n[...${label} truncated: ${elided} chars elided of ${text.length} total. Showing the first ${headChars} and last ${tailChars} characters.${hint}]\n\n`;
    return `${head}${marker}${tail}`;
}
