import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "@autonoma/evals";
import { casesDir } from "../framework/cases-dir";
import { ReporterEvaluation } from "./reporter-evaluation";
import { reporterFrontmatterSchema } from "./reporter-frontmatter";
import { reporterCaseInputSchema } from "./reporter-input";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = casesDir("reporter");
const RESULTS_DIR = path.join(__dirname, "results");

const cases = loadCases({
    casesDir: CASES_DIR,
    inputSchema: reporterCaseInputSchema,
    frontmatterSchema: reporterFrontmatterSchema,
});

new ReporterEvaluation(RESULTS_DIR, cases).runEvaluation();
