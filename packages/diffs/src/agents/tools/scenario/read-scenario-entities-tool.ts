import { AgentTool, FixableToolError } from "@autonoma/ai";
import { z } from "zod";
import type { ScenarioEntityRecord } from "../../../scenario-data";
import { boundRecords } from "./bound-records";
import type { ScenarioDataLoop } from "./scenario-data-loop";

/**
 * Aggregate output budget for a single call, mirroring the codebase `bash`
 * tool's output cap. Realistic scenarios return every record well
 * under this; only a pathological type (thousands of records, or records with
 * large blob fields) is truncated, with a marker telling the model how many
 * records were dropped.
 */
const MAX_OUTPUT_CHARS = 60_000;

const readScenarioEntitiesInputSchema = z.object({
    entityType: z
        .string()
        .describe(
            "The entity type to read full records for, e.g. 'User'. Must be one of the types listed in the scenario data summary.",
        ),
});

type ReadScenarioEntitiesInput = z.infer<typeof readScenarioEntitiesInputSchema>;

interface ReadScenarioEntitiesOutput {
    entityType: string;
    /** Total records the scenario created for this type, before any truncation. */
    count: number;
    records: ScenarioEntityRecord[];
    /** Present and true only when {@link MAX_OUTPUT_CHARS} forced some records to be dropped. */
    truncated?: boolean;
    /** Human-readable note describing the truncation, when it occurred. */
    note?: string;
}

class NoScenarioDataError extends FixableToolError {
    constructor() {
        super("This run has no resolved scenario data, so there are no entities to read.");
    }

    override suggestFix(): string {
        return "Do not call read_scenario_entities for this run - decide the verdict from the steps, video, and code change instead.";
    }
}

class UnknownEntityTypeError extends FixableToolError {
    constructor(
        public readonly entityType: string,
        public readonly availableTypes: string[],
    ) {
        super(`Unknown scenario entity type "${entityType}".`);
    }

    override suggestFix(): string {
        if (this.availableTypes.length === 0) {
            return "The scenario created no entity types - there is nothing to read.";
        }
        return `Available entity types: ${this.availableTypes.join(", ")}. Try again with one of those.`;
    }
}

/**
 * In-memory progressive-disclosure tool: returns every record the scenario
 * created for one entity type, read directly from the materialized payload held
 * in {@link ScenarioDataLoop.scenarioData}. No DB and no network access - the
 * summary in the prompt is bounded, and an agent that needs the full records
 * for a type (e.g. to confirm a specific id/value the test references) pulls
 * them through here.
 *
 * Agent-agnostic: the replay reviewer offers it today; resolution and healing
 * can register the same tool over their own loops.
 */
export class ReadScenarioEntitiesTool extends AgentTool<
    ReadScenarioEntitiesInput,
    ReadScenarioEntitiesOutput,
    ScenarioDataLoop
> {
    constructor() {
        super({
            name: "read_scenario_entities",
            description:
                "Read the full records the run's scenario created for a single entity type. " +
                "The scenario-data summary in the prompt lists each type with a bounded preview; call this " +
                "to see every field of every record for one type (e.g. to confirm whether a specific user, " +
                "item, or value the test plan references was actually seeded). Reads from in-memory scenario " +
                "data only - it performs no database or network access.",
            inputSchema: readScenarioEntitiesInputSchema,
        });
    }

    protected async execute(
        { entityType }: ReadScenarioEntitiesInput,
        loop: ScenarioDataLoop,
    ): Promise<ReadScenarioEntitiesOutput> {
        const data = loop.scenarioData;
        if (data == null) throw new NoScenarioDataError();

        const records = data.entities[entityType];
        if (records == null) throw new UnknownEntityTypeError(entityType, Object.keys(data.entities));

        const bounded = boundRecords(records, MAX_OUTPUT_CHARS);
        if (!bounded.truncated) {
            return { entityType, count: bounded.count, records: bounded.records };
        }

        return {
            entityType,
            count: bounded.count,
            records: bounded.records,
            truncated: true,
            note: `Returned the first ${bounded.records.length} of ${bounded.count} ${entityType} records; the rest were omitted because the full set exceeds the ${MAX_OUTPUT_CHARS}-char output budget.`,
        };
    }
}
