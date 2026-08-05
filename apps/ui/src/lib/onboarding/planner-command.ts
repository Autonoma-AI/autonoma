/**
 * The one command Autonoma hands people to run.
 *
 * It appears on two screens - the connect screen, where it is the whole of setup,
 * and Finish setup, where it uploads test artifacts - and they must never drift:
 * people paste it verbatim, and a variable missing from one of them is a run that
 * silently does less than the other.
 */

/** Where an agent reading the copied text is pointed for everything this can do. */
export const PLANNER_DOCS_URL = "https://docs.autonoma.app/test-planner/";

/** Stand-in shown on screen wherever a real credential would otherwise be rendered. */
const MASKED_VALUE = "•".repeat(24);

/**
 * Heads the copied text, and is deliberately NOT rendered on screen.
 *
 * It exists for readers the screen never reaches, and there are two of them, wanting
 * opposite things:
 *
 * A LOCAL agent, because the user pasted this into a session they already had open.
 * It must NOT run this itself. The command takes the terminal over and starts a
 * coding agent of its own, so running it from inside one nests two agents fighting
 * over the same screen. It should hand the command back to the person, who has a
 * terminal.
 *
 * A HOSTED agent, which has no person to hand anything to and no terminal to sign in
 * from. It must run this itself, with `--non-interactive`, which is the only path it
 * has.
 *
 * The instruction names products on both sides rather than only describing the
 * situation. A model recognises "you are Claude Code" faster and more reliably than
 * it reasons about whether a human is sitting beside it, and getting that wrong is
 * what decides between two agents deadlocked on one terminal and a run that never
 * starts. The principle follows the names, for anything the list does not cover.
 *
 * Losing these lines to brevity loses both audiences at once.
 */
function copyHeader(): string {
    return [
        "# Autonoma sets up your preview environment and generates your test suite.",
        "# Run this in a terminal, from your project folder.",
        "#",
        "# Agent reading this - which are you?",
        "#",
        "# A coding agent on the user's machine (Claude Code, Codex, Cursor): do NOT run",
        "# this yourself. Give it to them to run in their own terminal. It takes the",
        "# terminal over and starts a coding agent of its own, so running it from inside",
        "# one leaves two agents fighting over the same screen.",
        "#",
        "# A hosted agent with no human beside you (OpenClaw, Hermes, Devin, a CI job):",
        "# run it yourself and add --non-interactive. There is nobody to hand it to and",
        "# no terminal to sign in from, so that flag is your path.",
        "#",
        "#   --help              every action this can take",
        `#   docs                ${PLANNER_DOCS_URL}`,
    ].join("\n");
}

/** Everything the planner needs to attach a run to an Autonoma application. */
export interface PlannerCommandEnv {
    /**
     * Which Autonoma to talk to.
     *
     * Emitted always, from the same `VITE_API_URL` every other call in this app is
     * built from, rather than left to the CLI's own default. The command is copied
     * off whichever Autonoma the user is looking at, and its app id only exists
     * there - so a command copied from beta that silently addressed production
     * would fail on an application production has never heard of.
     */
    apiUrl: string;
    /** Authenticates the run; also what it uploads with. */
    apiToken: string;
    /** The setup its uploads belong to. */
    generationId: string;
    /** The application itself - what onboarding calls are keyed by. */
    applicationId: string;
    /** Signs SDK/webhook requests. Absent until the app has one. */
    sharedSecret?: string;
    /** PostHog identity, so CLI events join the signup funnel. */
    distinctId?: string;
}

/**
 * Build the command.
 *
 * `masked` replaces credential VALUES with dots for the on-screen copy. The real
 * command goes only to the clipboard, so a screenshot, a screen share, or someone
 * reading over a shoulder cannot leak a live token from a screen nobody thinks of as
 * sensitive.
 */
export function buildPlannerCommand(env: PlannerCommandEnv, { masked = false } = {}): string {
    const secret = (value: string): string => (masked ? MASKED_VALUE : value);
    const pairs = [
        `AUTONOMA_API_URL=${env.apiUrl}`,
        env.sharedSecret != null ? `AUTONOMA_SHARED_SECRET=${secret(env.sharedSecret)}` : undefined,
        env.distinctId != null ? `AUTONOMA_DISTINCT_ID=${env.distinctId}` : undefined,
        `AUTONOMA_API_TOKEN=${secret(env.apiToken)}`,
        `AUTONOMA_GENERATION_ID=${env.generationId}`,
        // Identifies the app itself, not this setup's uploads: it is what lets the CLI
        // read onboarding status, skip phases already done, and mint pairing codes for
        // the coding agents it hands off to.
        `AUTONOMA_APPLICATION_ID=${env.applicationId}`,
    ].filter((pair): pair is string => pair != null);

    return `${pairs.join(" ")} npx @autonoma-ai/planner@latest`;
}

/** The command as it reaches the clipboard: the guidance header, then the real thing. */
export function buildPlannerCommandForCopy(env: PlannerCommandEnv): string {
    return `${copyHeader()}\n${buildPlannerCommand(env)}`;
}
