import type { ScenarioEntityRecord } from "../../../scenario-data";

/** The records that fit within the budget, plus how many were dropped. */
export interface BoundedRecords {
    /** Whole records kept, in order, that fit within the char budget. */
    records: ScenarioEntityRecord[];
    /** Total records before any truncation. */
    count: number;
    /** True when {@link records} omits some of the input to stay within budget. */
    truncated: boolean;
}

/**
 * Return as many whole records as fit within `maxChars`. Always includes at
 * least the first record so the caller gets something even when a single record
 * is itself oversized; never slices inside a record so the output stays valid
 * JSON. Shared by the scenario-data and scenario-recipe disclosure tools.
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
