import { readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "@11ty/gray-matter";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";

export interface CoreFlow {
    feature: string;
    description?: string;
    mission?: string;
    core?: boolean;
    coreReason?: string;
}

/** Read AUTONOMA.md and return its `core_flows` frontmatter entries (or []). */
export async function parseCoreFlows(outputDir: string): Promise<CoreFlow[]> {
    let raw: string;
    try {
        raw = await readFile(join(outputDir, "AUTONOMA.md"), "utf-8");
    } catch {
        return [];
    }

    try {
        const parsed = matter(raw);
        const flows = parsed.data.core_flows;
        if (!Array.isArray(flows)) return [];
        return flows
            .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
            .map((f) => ({
                feature: String(f.feature ?? "").trim(),
                description: f.description != null ? String(f.description) : undefined,
                mission: f.mission != null ? String(f.mission) : undefined,
                core: f.core === true,
                coreReason: f.coreReason != null ? String(f.coreReason) : undefined,
            }))
            .filter((f) => f.feature.length > 0);
    } catch {
        return [];
    }
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1).trimEnd() + "…";
}

function pad(s: string, width: number): string {
    return s + " ".repeat(Math.max(0, width - s.length));
}

/** Render core flows as an aligned terminal table, core flows highlighted. */
export function renderFlowsTable(flows: CoreFlow[]): string {
    if (flows.length === 0) return "";

    const DESC_MAX = 60;
    const NAME_MAX = 32;

    const rows = flows.map((f, i) => ({
        num: String(i + 1),
        name: truncate(f.feature, NAME_MAX),
        crit: f.core ? "core" : "normal",
        desc: truncate((f.description ?? "").replace(/\s+/g, " ").trim(), DESC_MAX),
    }));

    const numW = Math.max(1, ...rows.map((r) => r.num.length));
    const nameW = Math.max("Flow".length, ...rows.map((r) => r.name.length));
    const critW = Math.max("Criticality".length, ...rows.map((r) => r.crit.length));

    const coreCount = flows.filter((f) => f.core).length;
    const header = `${BOLD}${pad("#", numW)}  ${pad("Flow", nameW)}  ${pad("Criticality", critW)}  Description${RESET}`;
    const sep = `${DIM}${"─".repeat(numW + nameW + critW + DESC_MAX + 6)}${RESET}`;

    const body = rows
        .map((r) => {
            const line = `${pad(r.num, numW)}  ${pad(r.name, nameW)}  ${pad(r.crit, critW)}  ${r.desc}`;
            // Highlight core flows so the user can eyeball criticality fast.
            return r.crit === "core" ? `${YELLOW}${line}${RESET}` : line;
        })
        .join("\n");

    const caption = `${DIM}${flows.length} flows · ${coreCount} marked core${RESET}`;

    return `${header}\n${sep}\n${body}\n${caption}`;
}
