import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "../framework/case-loader";
import { GenerationReviewEvaluation } from "./generation-review-evaluation";
import { generationReviewFrontmatterSchema } from "./generation-review-frontmatter";
import { generationReviewCaseInputSchema } from "./generation-review-input";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, "cases");
const RESULTS_DIR = path.join(__dirname, "results");

const cases = loadCases({
    casesDir: CASES_DIR,
    inputSchema: generationReviewCaseInputSchema,
    frontmatterSchema: generationReviewFrontmatterSchema,
});

new GenerationReviewEvaluation(RESULTS_DIR, cases).runEvaluation();
