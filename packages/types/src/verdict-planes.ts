import { type CoverageSummary, coverageVerdicts } from "./schemas/analysis";

/**
 * Derive a run's coverage plane from its per-test terminal verdicts - deterministically, in code, never by a model.
 * The coverage plane includes `plan_mismatch`: the run could not stabilize those tests, but it kept them. The
 * app-health plane (`client_bug` vs `passed`) is not derived here - it is the open-bug count's to answer.
 */
export function summarizeVerdictPlanes(categories: readonly string[]): CoverageSummary {
    const byCategory = coverageVerdicts
        .map((category) => ({ category, count: categories.filter((entry) => entry === category).length }))
        .filter((entry) => entry.count > 0);
    const total = byCategory.reduce((sum, entry) => sum + entry.count, 0);

    return { byCategory, total };
}
