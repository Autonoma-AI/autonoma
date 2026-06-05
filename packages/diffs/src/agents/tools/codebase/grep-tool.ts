import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { GrepHit } from "../../../codebase";
import type { CodebaseLoop } from "./codebase-loop";

/**
 * Per-match-line cap. Hits inside minified or generated files (bundled CSS, UMD bundles) put
 * the whole file on one line, so without this cap a single match can be hundreds of KB.
 */
const MAX_MATCH_LINE_CHARS = 300;

/**
 * Aggregate cap on the serialized character size of all hits returned from one call. Hits past
 * the budget are dropped and a {@link GrepOutput.truncationNote} explains the cut, signaling to
 * the agent to narrow its pattern or glob.
 */
const MAX_TOTAL_OUTPUT_CHARS = 100_000;

const grepInputSchema = z.object({
    pattern: z.string().describe("Regular expression to search for"),
    glob: z.string().optional().describe("Optional glob to restrict the search, e.g. 'src/**/*.tsx'"),
    maxResults: z.number().int().min(1).max(200).optional(),
});

type GrepInput = z.infer<typeof grepInputSchema>;

interface GrepOutput {
    hits: GrepHit[];
    truncationNote?: string;
}

/**
 * Search the codebase for a regex pattern via ripgrep. No-match is a successful operation that
 * returns an empty `hits` array - the tool only throws on infra failures (ripgrep missing,
 * broken codebase root).
 *
 * Hits are subject to two bounds: each match line is truncated to {@link MAX_MATCH_LINE_CHARS}
 * (cheap protection against single-line minified files), and the aggregate hit payload is
 * capped at {@link MAX_TOTAL_OUTPUT_CHARS}; hits past the aggregate cap are dropped and a
 * `truncationNote` is set so the caller can narrow the query.
 */
export class GrepTool extends AgentTool<GrepInput, GrepOutput, CodebaseLoop> {
    constructor() {
        super({
            name: "grep",
            description:
                "Search the application's source tree for a regular expression (uses ripgrep). " +
                "Returns up to 100 matches by default (up to 200 if you raise maxResults) with file paths and line numbers. " +
                `Each match line is truncated to ${MAX_MATCH_LINE_CHARS} characters and the total response is bounded around ${MAX_TOTAL_OUTPUT_CHARS} characters - ` +
                "if you see truncation markers, the hit landed in a long (likely minified) line or the total exceeded the cap, so narrow your pattern or glob.",
            inputSchema: grepInputSchema,
        });
    }

    protected async execute(input: GrepInput, loop: CodebaseLoop): Promise<GrepOutput> {
        const rawHits = await loop.codebase.grep(input.pattern, { glob: input.glob, maxResults: input.maxResults });
        const truncatedHits = rawHits.map(truncateHit);
        return capAggregateSize(truncatedHits);
    }
}

function truncateHit(hit: GrepHit): GrepHit {
    if (hit.match.length <= MAX_MATCH_LINE_CHARS) return hit;
    const head = hit.match.slice(0, MAX_MATCH_LINE_CHARS);
    return {
        ...hit,
        match: `${head} [...truncated: line was ${hit.match.length} chars; narrow your pattern or glob to avoid bundled / minified files]`,
    };
}

function capAggregateSize(hits: GrepHit[]): GrepOutput {
    const kept: GrepHit[] = [];
    let cumulativeChars = 0;
    for (const hit of hits) {
        const hitChars = hit.path.length + hit.match.length;
        if (cumulativeChars + hitChars > MAX_TOTAL_OUTPUT_CHARS) {
            const dropped = hits.length - kept.length;
            return {
                hits: kept,
                truncationNote: `Aggregate response exceeded ${MAX_TOTAL_OUTPUT_CHARS} characters; returned the first ${kept.length} of ${hits.length} hits and dropped the remaining ${dropped}. Narrow the pattern or glob to see more.`,
            };
        }
        kept.push(hit);
        cumulativeChars += hitChars;
    }
    return { hits: kept };
}
