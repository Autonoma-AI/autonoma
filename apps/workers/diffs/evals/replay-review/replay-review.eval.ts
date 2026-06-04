import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "../framework/case-loader";
import { ReplayReviewEvaluation } from "./replay-review-evaluation";
import { replayReviewFrontmatterSchema } from "./replay-review-frontmatter";
import { replayReviewCaseInputSchema } from "./replay-review-input";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, "cases");
const RESULTS_DIR = path.join(__dirname, "results");

const cases = loadCases({
    casesDir: CASES_DIR,
    inputSchema: replayReviewCaseInputSchema,
    frontmatterSchema: replayReviewFrontmatterSchema,
});

new ReplayReviewEvaluation(RESULTS_DIR, cases).runEvaluation();
