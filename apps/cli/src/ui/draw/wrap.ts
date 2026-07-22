/** Word-wrap plain `text` to `maxW`, greedy; words longer than the measure land on their own line. */
export function wrapPlain(text: string, maxW: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const word of words) {
        if (cur !== "" && (cur + " " + word).length > maxW) {
            lines.push(cur);
            cur = word;
        } else {
            cur = cur === "" ? word : `${cur} ${word}`;
        }
    }
    if (cur !== "") lines.push(cur);
    return lines;
}
