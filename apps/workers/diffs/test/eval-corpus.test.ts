import { existsSync } from "node:fs";
import { loadCases } from "@autonoma/evals";
import { describe, expect, it } from "vitest";
import { analysisFrontmatterSchema } from "../evals/analysis/analysis-frontmatter";
import { analysisCaseInputSchema } from "../evals/analysis/analysis-input";
import { classifierFrontmatterSchema } from "../evals/classifier/classifier-frontmatter";
import { classifierCaseInputSchema } from "../evals/classifier/classifier-input";
import { casesDir } from "../evals/framework/cases-dir";
import { reporterFrontmatterSchema } from "../evals/reporter/reporter-frontmatter";
import { reporterCaseInputSchema } from "../evals/reporter/reporter-input";

/**
 * The corpus is committed beside the harness, so a schema change that no longer reads the cases
 * on disk should fail here, in the fast key-free suite, rather than the next time somebody pays
 * for an eval run. `loadCases` throws on an active case it cannot parse.
 *
 * Each case skips when its folder is absent: `evals/cases/` is stripped from the public mirror,
 * where `pnpm test` must still pass.
 */

const ANALYSIS_CASES = casesDir("analysis");
const CLASSIFIER_CASES = casesDir("classifier");
const REPORTER_CASES = casesDir("reporter");

describe("committed eval corpus", () => {
    it.skipIf(!existsSync(ANALYSIS_CASES))("loads every analysis case against the current schemas", () => {
        const cases = loadCases({
            casesDir: ANALYSIS_CASES,
            inputSchema: analysisCaseInputSchema,
            frontmatterSchema: analysisFrontmatterSchema,
        });

        expect(cases.length).toBeGreaterThan(0);
    });

    it.skipIf(!existsSync(CLASSIFIER_CASES))("loads every classifier case against the current schemas", () => {
        const cases = loadCases({
            casesDir: CLASSIFIER_CASES,
            inputSchema: classifierCaseInputSchema,
            frontmatterSchema: classifierFrontmatterSchema,
        });

        expect(cases.length).toBeGreaterThan(0);
    });

    it.skipIf(!existsSync(REPORTER_CASES))("loads every reporter case against the current schemas", () => {
        const cases = loadCases({
            casesDir: REPORTER_CASES,
            inputSchema: reporterCaseInputSchema,
            frontmatterSchema: reporterFrontmatterSchema,
        });

        expect(cases.length).toBeGreaterThan(0);
    });
});
