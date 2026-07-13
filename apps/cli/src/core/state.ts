import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { debugLog } from "./debug";

const StepStatusSchema = z.enum(["pending", "running", "done", "failed", "paused"]);

export type StepStatus = z.infer<typeof StepStatusSchema>;

// A step key absent from an existing state file predates that step's introduction, so an
// older run never had a chance to run it. Default missing keys to "done" on load so adding a
// new pipeline step never silently re-triggers work an already-completed run considers finished.
const PipelineStateSchema = z.object({
    steps: z.object({
        projectMapper: StepStatusSchema.default("done"),
        pagesFinder: StepStatusSchema.default("done"),
        kb: StepStatusSchema.default("done"),
        entityAudit: StepStatusSchema.default("done"),
        scenarioRecipe: StepStatusSchema.default("done"),
        recipeBuilder: StepStatusSchema.default("done"),
        testGenerator: StepStatusSchema.default("done"),
    }),
});

export type PipelineState = z.infer<typeof PipelineStateSchema>;

const STATE_FILE = ".pipeline-state.json";

export function initialState(): PipelineState {
    return {
        steps: {
            projectMapper: "pending",
            pagesFinder: "pending",
            kb: "pending",
            entityAudit: "pending",
            scenarioRecipe: "pending",
            recipeBuilder: "pending",
            testGenerator: "pending",
        },
    };
}

export async function loadState(outputDir: string): Promise<PipelineState> {
    const path = join(outputDir, STATE_FILE);
    try {
        const raw = await readFile(path, "utf-8");
        return PipelineStateSchema.parse(JSON.parse(raw));
    } catch (err) {
        // Missing file is the expected first-run path; a present-but-unreadable/invalid file
        // means we are silently discarding prior progress, so leave a breadcrumb for that case.
        const isMissingFile = err instanceof Error && "code" in err && err.code === "ENOENT";
        if (!isMissingFile) debugLog("Failed to load pipeline state, starting fresh", { path, err });
        return initialState();
    }
}

export async function saveState(outputDir: string, state: PipelineState): Promise<void> {
    const path = join(outputDir, STATE_FILE);
    await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

export type StepName = keyof PipelineState["steps"];

export async function markStep(
    outputDir: string,
    state: PipelineState,
    step: StepName,
    status: StepStatus,
): Promise<PipelineState> {
    const updated = {
        ...state,
        steps: { ...state.steps, [step]: status },
    };
    await saveState(outputDir, updated);
    return updated;
}

export function nextPendingStep(state: PipelineState): StepName | undefined {
    const order: StepName[] = [
        "projectMapper",
        "pagesFinder",
        "kb",
        "entityAudit",
        "scenarioRecipe",
        "recipeBuilder",
        "testGenerator",
    ];
    return order.find((s) => state.steps[s] !== "done") ?? undefined;
}
