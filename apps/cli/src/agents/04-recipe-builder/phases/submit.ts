import type { AppConfig } from "../../../config";
import * as p from "../../../ui/prompts";
import { type FullRecipeJson, RECIPE_FILE, loadRecipe } from "../recipe";

const UPLOAD_COMMAND = "npx @autonoma-ai/planner@latest upload";

export interface SubmitCredentials {
    apiUrl: string;
    apiToken?: string;
    generationId?: string;
}

/**
 * Why a recipe never reached Autonoma. `no-credentials` is the only benign one - the
 * planner is running standalone, outside onboarding, and there is nowhere to upload to.
 * Every other reason means an onboarding run silently lost its recipe, so the caller
 * must fail the step rather than let the pipeline march on.
 */
export type SubmitFailure = "no-recipe" | "no-credentials" | "rejected";

export type SubmitOutcome = { uploaded: true } | { uploaded: false; failure: SubmitFailure };

export interface SubmitResult {
    /** Local path (relative to the output dir) the recipe was read from. */
    recipePath: string;
    outcome: SubmitOutcome;
}

/**
 * Take the upload credentials off the resolved config rather than off raw env. `apiUrl`
 * carries the production default, so an onboarding run - whose launch command sets only
 * the token and the generation id - still has a host to submit to.
 */
function credentialsFrom(config: AppConfig): SubmitCredentials {
    return {
        apiUrl: config.autonomaApiUrl,
        apiToken: config.autonomaApiToken,
        generationId: config.autonomaGenerationId,
    };
}

/**
 * Submit the recipe that already sits on disk - the one the agent generated and
 * validated (or, non-interactively, the drafted one). The CLI never rebuilds the
 * recipe from its own state here: the agent may have written `recipe.json` directly
 * during handoff, and that on-disk file is the source of truth. Returns why the
 * upload failed so the caller can fail the step instead of masking a rejected upload
 * as success.
 */
export async function runSubmit(outputDir: string, config: AppConfig): Promise<SubmitResult> {
    const recipe = await loadRecipe(outputDir);
    if (recipe == null) {
        p.log.error(`No ${RECIPE_FILE} found in ${outputDir} to submit.`);
        return { recipePath: RECIPE_FILE, outcome: { uploaded: false, failure: "no-recipe" } };
    }

    const outcome = await submitRecipe(recipe, credentialsFrom(config));
    return { recipePath: RECIPE_FILE, outcome };
}

/**
 * Load a previously generated `recipe.json` from the output dir and submit it,
 * without re-running the whole planner. Backs the `upload` command so a
 * failed/lost upload can be retried on its own.
 */
export async function uploadRecipeFromDisk(outputDir: string, config: AppConfig): Promise<boolean> {
    const recipe = await loadRecipe(outputDir);
    if (recipe == null) {
        p.log.error(
            `No ${RECIPE_FILE} found in ${outputDir}. Run the planner's recipe step first to generate it, then retry.`,
        );
        return false;
    }
    const outcome = await submitRecipe(recipe, credentialsFrom(config));
    return outcome.uploaded;
}

/**
 * POST a recipe to Autonoma's versioned scenario-recipe endpoint. On any failure
 * the recipe is printed to stdout in full with a re-upload instruction, so it is
 * never lost - even when the CLI runs in an ephemeral container whose `~/.autonoma`
 * filesystem is discarded on exit.
 */
export async function submitRecipe(recipe: FullRecipeJson, creds: SubmitCredentials): Promise<SubmitOutcome> {
    const { apiUrl, apiToken, generationId } = creds;

    const missing = [
        apiToken == null ? "AUTONOMA_API_TOKEN" : undefined,
        generationId == null ? "AUTONOMA_GENERATION_ID" : undefined,
    ].filter((name): name is string => name != null);

    if (apiToken == null || generationId == null) {
        p.log.info(
            `Autonoma credentials not configured (${missing.join(", ")}) - recipe saved locally, not uploaded. ` +
                `Set them and run \`${UPLOAD_COMMAND}\` to publish it.`,
        );
        return { uploaded: false, failure: "no-credentials" };
    }

    const url = `${apiUrl}/v1/setup/setups/${generationId}/scenario-recipe-versions`;

    p.log.step(`Submitting recipe to Autonoma (${apiUrl})...`);

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
        return { uploaded: false, failure: "rejected" };
    }

    if (res.ok) {
        p.log.success(`Recipe submitted successfully (HTTP ${res.status})`);
        return { uploaded: true };
    }

    const text = await res.text();
    p.log.error(`Recipe submission failed (HTTP ${res.status}): ${text}`);
    printRecipeForRecovery(recipe);
    return { uploaded: false, failure: "rejected" };
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
            "(with the same AUTONOMA_API_TOKEN / AUTONOMA_GENERATION_ID env vars set)",
            "─".repeat(72),
            JSON.stringify(recipe, null, 2),
            "─".repeat(72),
            "",
        ].join("\n"),
    );
}
