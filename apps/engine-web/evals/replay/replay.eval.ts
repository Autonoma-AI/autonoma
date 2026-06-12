import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "@autonoma/evals";
import { ReplayEvaluation } from "./replay-evaluation";
import { replayEvalFrontmatterSchema } from "./replay-frontmatter";
import { replayEvalInputSchema } from "./replay-input";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, "cases");
const RESULTS_DIR = path.join(__dirname, "results");

const cases = loadCases({
    casesDir: CASES_DIR,
    inputSchema: replayEvalInputSchema,
    frontmatterSchema: replayEvalFrontmatterSchema,
});

new ReplayEvaluation(RESULTS_DIR, cases).runEvaluation();
