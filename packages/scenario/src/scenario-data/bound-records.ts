import type { ScenarioEntityRecord } from "./types";

export interface BoundedRecords {
    records: ScenarioEntityRecord[];
    count: number;
    truncated: boolean;
}

/**
 * Return as many whole records as fit within `maxChars`. Always includes at
 * least the first record so the caller gets something even when a single record
 * is itself oversized; never slices inside a record so the output stays valid
 * JSON.
 */
export function boundRecords(records: ScenarioEntityRecord[], maxChars: number): BoundedRecords {
    const kept: ScenarioEntityRecord[] = [];
    let usedChars = 0;
    for (const record of records) {
        const recordChars = JSON.stringify(record).length;
        if (kept.length > 0 && usedChars + recordChars > maxChars) break;
        kept.push(record);
        usedChars += recordChars;
    }

    return { records: kept, count: records.length, truncated: kept.length < records.length };
}
