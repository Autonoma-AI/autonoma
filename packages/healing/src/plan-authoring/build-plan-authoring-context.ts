import type { FlowSummary, PlanAuthoringContextInput, ScenarioSummary, SkillSummary } from "./types";

/**
 * Renders the runtime plan-authoring context section to inject in an agent's
 * user prompt. Pairs with PLAN_AUTHORING_GUIDE (which goes in the system
 * prompt) to give the agent both the rules and the live menu of scenarios,
 * skills, and flows it can reference.
 *
 * Pass `scenarios: undefined` for agents that should not pick scenarios (the
 * diffs analyzer keeps its scope to coverage + impact only).
 */
export function buildPlanAuthoringContext(input: PlanAuthoringContextInput): string {
    const sections = ["# Plan Authoring Context"];
    sections.push(
        "When you write or modify a plan body, reference the data below by exact id / slug / name. The plan-authoring guide in your system prompt explains the body shape and the rules; this section lists what is actually available in this run.",
    );

    if (input.scenarios != null) {
        sections.push(renderScenarios(input.scenarios));
    }

    sections.push(renderSkills(input.skills));
    sections.push(renderFlows(input.flows));

    return sections.join("\n\n");
}

function renderScenarios(scenarios: ScenarioSummary[]): string {
    if (scenarios.length === 0) {
        return "## Available scenarios\n\nNone seeded for this application. A new test that needs preconditions cannot pick a scenario — propose one only if you also propose seeding the data.";
    }

    const lines = [
        "## Available scenarios",
        "Each scenario is a named test data environment. When you attach a scenario to a test, the platform seeds the customer's app with that scenario's fixture data before execution. Use `read_scenario` to inspect the seeded entities and use their exact names/values in assertions. Never invent a scenario id.",
    ];
    for (const s of scenarios) {
        const desc = s.description != null ? ` — ${s.description}` : "";
        lines.push(`- \`${s.id}\` **${s.name}**${desc}`);
    }
    return lines.join("\n");
}

function renderSkills(skills: SkillSummary[]): string {
    if (skills.length === 0) {
        return "## Available skills\n\nNone defined for this application. Write every action inline.";
    }

    const lines = [
        "## Available skills",
        "Reusable sub-flows. Reference a skill by its slug when a step would duplicate its steps. Use `read_skill` if you need the skill's full body before writing a plan that references it.",
    ];
    for (const s of skills) {
        lines.push(`- \`${s.slug}\` **${s.name}** — ${s.description}`);
    }
    return lines.join("\n");
}

function renderFlows(flows: FlowSummary[]): string {
    if (flows.length === 0) {
        return "## Flows\n\nNo flows defined yet.";
    }

    const lines = [
        "## Flows",
        "Tests are organised into flows (folders). When you create or modify a test, place it in the flow that matches the feature.",
    ];
    for (const f of flows) {
        const desc = f.description != null ? ` — ${f.description}` : "";
        lines.push(`- **${f.name}** (${f.testCount} tests)${desc}`);
    }
    return lines.join("\n");
}
