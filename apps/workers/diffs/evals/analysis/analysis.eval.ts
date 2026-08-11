import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "@autonoma/evals";
import { casesDir } from "../framework/cases-dir";
import { AnalysisEvaluation } from "./analysis-evaluation";
import { analysisFrontmatterSchema } from "./analysis-frontmatter";
import { analysisCaseInputSchema } from "./analysis-input";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = casesDir("analysis");
const RESULTS_DIR = path.join(__dirname, "results");

const cases = loadCases({
    casesDir: CASES_DIR,
    inputSchema: analysisCaseInputSchema,
    frontmatterSchema: analysisFrontmatterSchema,
});

new AnalysisEvaluation(RESULTS_DIR, cases).runEvaluation();
