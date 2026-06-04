import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "../framework/case-loader";
import { ResolutionEvaluation } from "./resolution-evaluation";
import { resolutionFrontmatterSchema } from "./resolution-frontmatter";
import { resolutionCaseInputSchema } from "./resolution-input";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, "cases");
const RESULTS_DIR = path.join(__dirname, "results");

const cases = loadCases({
    casesDir: CASES_DIR,
    inputSchema: resolutionCaseInputSchema,
    frontmatterSchema: resolutionFrontmatterSchema,
});

new ResolutionEvaluation(RESULTS_DIR, cases).runEvaluation();
