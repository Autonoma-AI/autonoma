import type { SuiteHealth } from "@autonoma/types";
import { baseSuiteHealth } from "./base-fixtures";

/**
 * Builds a suite-health fixture off the CALIBRATING baseline. Lives here rather than in a `.stories` file because
 * Storybook treats every export of one as a story - a helper exported from there shows up in the sidebar as an
 * empty "Suite Health Fixture" entry.
 */
export function suiteHealthFixture(
    overrides: Partial<SuiteHealth>,
    breakdown: Partial<SuiteHealth["breakdown"]>,
): SuiteHealth {
    return {
        ...baseSuiteHealth,
        ...overrides,
        evidence: { ...baseSuiteHealth.evidence, ...overrides.evidence },
        breakdown: { ...baseSuiteHealth.breakdown, ...breakdown },
    };
}
