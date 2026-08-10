/**
 * The branch an agent cuts off the repo's default branch to carry Autonoma
 * integration work - preview config, the SDK handler, Dockerfile fixes.
 *
 * Onboarding never writes to a customer's default branch: preview config is
 * unproven until a preview has actually built from it, and nobody wants a
 * half-finished integration on their trunk. The work lands here, the base
 * preview is pointed at it, and it reaches the default branch the way every
 * other change does - as a reviewed pull request.
 *
 * Shared because both the planner CLI (which cuts the branch locally) and the
 * onboarding MCP (which tells a coding agent to cut it, and names it back in its
 * instructions) have to agree on the name, or a second session opens a second
 * branch and the base preview follows the wrong one.
 */
export const INTEGRATION_BRANCH = "autonoma-integration";
