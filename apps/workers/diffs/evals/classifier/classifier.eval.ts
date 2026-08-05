import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "@autonoma/evals";
import { resolveCasesDir } from "../framework/cases-dir";
import { ClassifierEvaluation } from "./classifier-evaluation";
import { classifierFrontmatterSchema } from "./classifier-frontmatter";
import { classifierCaseInputSchema } from "./classifier-input";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = resolveCasesDir("classifier");
const RESULTS_DIR = path.join(__dirname, "results");

const cases = loadCases({
    casesDir: CASES_DIR,
    inputSchema: classifierCaseInputSchema,
    frontmatterSchema: classifierFrontmatterSchema,
});

new ClassifierEvaluation(RESULTS_DIR, cases).runEvaluation();
