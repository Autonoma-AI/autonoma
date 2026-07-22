import * as p from "../../../ui/prompts";
import { type FullRecipeJson, RECIPE_FILE, loadRecipe } from "../recipe";

const UPLOAD_COMMAND = "npx @autonoma-ai/planner@latest upload";

export interface SubmitCredentials {
    apiUrl?: string;
    apiToken?: string;
    generationId?: string;
}

export interface SubmitResult {
    /** Local path (relative to the output dir) the recipe was read from. */
    recipePath: string;
    /** True only when the recipe was accepted by Autonoma. */
    uploaded: boolean;
}

/**
 * Submit the recipe that already sits on disk - the one the agent generated and
 * validated (or, non-interactively, the drafted one). The CLI never rebuilds the
 * recipe from its own state here: the agent may have written `recipe.json` directly
 * during handoff, and that on-disk file is the source of truth. Returns whether the
 * upload actually succeeded so the caller can fail the step instead of masking a
 * rejected upload as success.
 */
export async function runSubmit(
    outputDir: string,
    autonomaApiUrl?: string,
    autonomaApiToken?: string,
    autonomaGenerationId?: string,
): Promise<SubmitResult> {
    const recipe = await loadRecipe(outputDir);
    if (recipe == null) {
        p.log.error(`No ${RECIPE_FILE} found in ${outputDir} to submit.`);
        return { recipePath: RECIPE_FILE, uploaded: false };
    }

    const uploaded = await submitRecipe(recipe, {
        apiUrl: autonomaApiUrl,
        apiToken: autonomaApiToken,
        generationId: autonomaGenerationId,
    });

    return { recipePath: RECIPE_FILE, uploaded };
}

/**
 * Load a previously generated `recipe.json` from the output dir and submit it,
 * without re-running the whole planner. Backs the `upload` command so a
 * failed/lost upload can be retried on its own.
 */
export async function uploadRecipeFromDisk(outputDir: string, creds: SubmitCredentials): Promise<boolean> {
    const recipe = await loadRecipe(outputDir);
    if (recipe == null) {
        p.log.error(
            `No ${RECIPE_FILE} found in ${outputDir}. Run the planner's recipe step first to generate it, then retry.`,
        );
        return false;
    }
    return submitRecipe(recipe, creds);
}

/**
 * POST a recipe to Autonoma's versioned scenario-recipe endpoint. On any failure
 * (including missing credentials) the recipe is printed to stdout in full with a
 * re-upload instruction, so it is never lost - even when the CLI runs in an
 * ephemeral container whose `~/.autonoma` filesystem is discarded on exit.
 */
export async function submitRecipe(recipe: FullRecipeJson, creds: SubmitCredentials): Promise<boolean> {
    const { apiUrl, apiToken, generationId } = creds;

    if (!apiUrl || !apiToken || !generationId) {
        p.log.info(
            "Autonoma API credentials not configured - recipe saved locally, not uploaded. Set AUTONOMA_API_URL, AUTONOMA_API_TOKEN and AUTONOMA_GENERATION_ID, then run `" +
                UPLOAD_COMMAND +
                "`.",
        );
        return false;
    }

    const url = `${apiUrl.replace(/\/+$/, "")}/v1/setup/setups/${generationId}/scenario-recipe-versions`;

    p.log.step("Submitting recipe to Autonoma...");

    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiToken}`,
            },
            body: JSON.stringify(recipe),
        });
    } catch (err) {
        p.log.error(`Recipe submission failed (network error): ${err instanceof Error ? err.message : String(err)}`);
        printRecipeForRecovery(recipe);
        return false;
    }

    if (res.ok) {
        p.log.success(`Recipe submitted successfully (HTTP ${res.status})`);
        return true;
    }

    const text = await res.text();
    p.log.error(`Recipe submission failed (HTTP ${res.status}): ${text}`);
    printRecipeForRecovery(recipe);
    return false;
}

/**
 * Print the full recipe JSON plus a copy-paste recovery command. Uses console.log
 * (not the prompt logger) so the block is clean and easy to pipe/save.
 */
function printRecipeForRecovery(recipe: FullRecipeJson): void {
    console.log(
        [
            "",
            "─".repeat(72),
            "RECIPE NOT UPLOADED - copy the JSON below into a recipe.json and re-upload with:",
            `  ${UPLOAD_COMMAND}`,
            "(with the same AUTONOMA_API_URL / AUTONOMA_API_TOKEN / AUTONOMA_GENERATION_ID env vars set)",
            "─".repeat(72),
            JSON.stringify(recipe, null, 2),
            "─".repeat(72),
            "",
        ].join("\n"),
    );
}
