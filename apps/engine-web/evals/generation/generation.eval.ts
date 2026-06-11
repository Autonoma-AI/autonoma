import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "@autonoma/evals";
import { GenerationEvaluation } from "./generation-evaluation";
import { generationEvalFrontmatterSchema } from "./generation-frontmatter";
import { generationEvalInputSchema } from "./generation-input";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, "cases");
const RESULTS_DIR = path.join(__dirname, "results");

const cases = loadCases({
    casesDir: CASES_DIR,
    inputSchema: generationEvalInputSchema,
    frontmatterSchema: generationEvalFrontmatterSchema,
});

new GenerationEvaluation(RESULTS_DIR, cases).runEvaluation();
