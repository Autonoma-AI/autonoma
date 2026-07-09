/** A scenario candidate the standard-scenario picker chooses from (an app's scenario, id + name). */
export interface ScenarioChoice {
    id: string;
    name: string;
}

/**
 * Pick the scenario to seed a proposed new test against from an application's scenarios. Organizations usually
 * have exactly one scenario, conventionally named "standard": prefer a case-insensitive (trimmed) "standard"
 * name match, fall back to the sole scenario when there is exactly one, and otherwise return undefined - a
 * proposal then validates unseeded rather than guessing among several ambiguous scenarios (a wrong guess could
 * seed misleading data and produce a false pass). Pure so it is unit-tested without a DB.
 */
export function pickStandardScenario(scenarios: ScenarioChoice[]): ScenarioChoice | undefined {
    const standard = scenarios.find((scenario) => scenario.name.trim().toLowerCase() === "standard");
    if (standard != null) return standard;
    if (scenarios.length === 1) return scenarios[0];
    return undefined;
}
