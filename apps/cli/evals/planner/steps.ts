import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The planner steps a Layer-1 eval can grade, in pipeline order. `outputs` are the
 * artifacts a step produces; they double as the seeding exclusion list (we seed a
 * step's UPSTREAM frozen artifacts but never its own output - so the step can't
 * read its own answer, and a resumable step like recipeBuilder starts fresh).
 * `primary` is the artifact the judge reads and that `--promote` writes back.
 */
export interface PlannerStep {
    /** The CLI --step flag. */
    flag: string;
    /** Files/dirs (relative to the output dir) this step produces. */
    outputs: string[];
    /** The artifact the judge grades (a file, or a dir whose files are concatenated). */
    primary: string;
}

export const PLANNER_STEPS: Record<string, PlannerStep> = {
    kb: { flag: "kb", outputs: ["AUTONOMA.md", "skills"], primary: "AUTONOMA.md" },
    entityAudit: { flag: "entityAudit", outputs: ["entity-audit.md"], primary: "entity-audit.md" },
    scenarioRecipe: { flag: "scenarioRecipe", outputs: ["scenarios.md"], primary: "scenarios.md" },
    recipeBuilder: { flag: "recipeBuilder", outputs: ["recipe.json"], primary: "recipe.json" },
};

export function isPlannerStep(name: string): name is keyof typeof PLANNER_STEPS {
    return name in PLANNER_STEPS;
}

/**
 * Read a step's produced artifact as text for the judge. A directory artifact
 * (e.g. the kb `skills/`) is concatenated file-by-file with headers so the whole
 * output is graded, not just a single file.
 */
export function readArtifact(outputDir: string, primary: string): string {
    const path = join(outputDir, primary);
    if (!existsSync(path)) {
        throw new Error(`Expected artifact "${primary}" was not produced (looked in ${outputDir}).`);
    }
    if (!statSync(path).isDirectory()) return readFileSync(path, "utf-8");

    const parts: string[] = [];
    const stack = [path];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) stack.push(full);
            else parts.push(`\n----- ${relative(path, full)} -----\n${readFileSync(full, "utf-8")}`);
        }
    }
    return parts.join("\n");
}
