import { describe, expect, test } from "vitest";
import { buildPlannerCommand, buildPlannerCommandForCopy, PLANNER_DOCS_URL } from "./planner-command";

const ENV = {
    apiUrl: "https://api.autonoma.app",
    apiToken: "ask_live_token",
    generationId: "setup_1",
    applicationId: "app_1",
    sharedSecret: "shh_live_secret",
    distinctId: "user_1",
};

describe("buildPlannerCommand", () => {
    test("carries every variable a run needs, in a single pasteable line", () => {
        expect(buildPlannerCommand(ENV)).toBe(
            "AUTONOMA_API_URL=https://api.autonoma.app AUTONOMA_SHARED_SECRET=shh_live_secret AUTONOMA_DISTINCT_ID=user_1 AUTONOMA_API_TOKEN=ask_live_token " +
                "AUTONOMA_GENERATION_ID=setup_1 AUTONOMA_APPLICATION_ID=app_1 npx @autonoma-ai/planner@latest",
        );
    });

    // The app id in the command exists only on the Autonoma the command was copied
    // from. Left to its own default the CLI would address production about an
    // application production has never heard of, which is what made a command copied
    // off beta unusable.
    test("addresses the Autonoma it was copied from, not whichever one is the default", () => {
        const command = buildPlannerCommand({ ...ENV, apiUrl: "https://api.beta.autonoma.app" });

        expect(command).toContain("AUTONOMA_API_URL=https://api.beta.autonoma.app");
        expect(command).not.toContain("api.autonoma.app ");
    });

    test("omits what the app does not have yet rather than emitting an empty value", () => {
        const command = buildPlannerCommand({
            apiUrl: "https://api.autonoma.app",
            apiToken: "ask_live_token",
            generationId: "setup_1",
            applicationId: "app_1",
        });

        expect(command).not.toContain("AUTONOMA_SHARED_SECRET");
        expect(command).not.toContain("AUTONOMA_DISTINCT_ID");
        expect(command).toContain("AUTONOMA_APPLICATION_ID=app_1");
    });

    // A screenshot, a screen share, or someone reading over a shoulder must not be able
    // to lift a live credential off a screen nobody treats as sensitive.
    // The connect screen renders before any token exists - it is minted on copy - so
    // the masked form has to read as a command even with nothing to mask.
    test("renders as a command when the token has not been minted yet", () => {
        const shown = buildPlannerCommand({ ...ENV, apiToken: "" }, { masked: true });

        expect(shown).toContain("AUTONOMA_API_TOKEN=");
        expect(shown).not.toContain("AUTONOMA_API_TOKEN= ");
        expect(shown).toContain("npx @autonoma-ai/planner@latest");
    });

    test("masks credential values on screen but not the identifiers", () => {
        const shown = buildPlannerCommand(ENV, { masked: true });

        expect(shown).not.toContain("ask_live_token");
        expect(shown).not.toContain("shh_live_secret");
        // Ids are not credentials, and a masked one makes the command unreadable.
        expect(shown).toContain("AUTONOMA_GENERATION_ID=setup_1");
        expect(shown).toContain("AUTONOMA_APPLICATION_ID=app_1");
        expect(shown).toContain("AUTONOMA_DISTINCT_ID=user_1");
    });

    test("what reaches the clipboard is the real command", () => {
        expect(buildPlannerCommandForCopy(ENV)).toContain(buildPlannerCommand(ENV));
    });

    // The header's audience is an agent that was handed this command in a chat window
    // and can never see the screen: --non-interactive is the only path it has.
    // Two agents read this wanting opposite things, and one header serves both. A local
    // one, pasted into a session the user already had open, must hand the command back
    // rather than run it: it takes the terminal over and starts an agent of its own, so
    // running it from inside one nests two agents on one screen.
    test("tells a local agent to hand the command over instead of running it", () => {
        const copied = buildPlannerCommandForCopy(ENV);

        expect(copied).toContain("do NOT run");
        // Named, not only described: a model recognises "you are Claude Code" faster
        // and more reliably than it reasons about whether a human is beside it.
        expect(copied).toContain("Claude Code, Codex, Cursor");
    });

    // A hosted one - Devin, OpenClaw, a CI job - has nobody to hand it to, so the same
    // header has to send it the other way.
    test("tells a headless agent to run it itself, non-interactively", () => {
        const copied = buildPlannerCommandForCopy(ENV);

        expect(copied).toContain("OpenClaw, Hermes, Devin, a CI job");
        expect(copied).toContain("no human beside you");
        expect(copied).toContain("--non-interactive");
        expect(copied).toContain("--help");
        expect(copied).toContain(PLANNER_DOCS_URL);
    });

    // zsh does not comment `#` interactively unless `interactive_comments` is set,
    // and it is off by default. Without the setopt line an apostrophe in the prose
    // opens a quote that swallows the command and the credentials behind it, leaving
    // a `quote>` prompt and nothing run - seen on a real machine, in Cursor's console.
    test("survives a paste into a shell that does not comment interactively", () => {
        const copied = buildPlannerCommandForCopy(ENV);

        expect(copied.split("\n")[0]).toBe("setopt interactive_comments 2>/dev/null || true");
    });

    // Belt and braces for the same failure: with no apostrophe, a shell that somehow
    // ignored the line above still recovers and runs the command, instead of hanging
    // on an unterminated quote.
    test("carries no apostrophe that could open a quote", () => {
        const header = buildPlannerCommandForCopy(ENV).split("AUTONOMA_API_URL=")[0] ?? "";

        expect(header).not.toContain("'");
    });

    // None of that guidance is rendered - a human is already reading the screen.
    test("keeps the guidance out of what the screen shows", () => {
        expect(buildPlannerCommand(ENV)).not.toContain("--non-interactive");
        expect(buildPlannerCommand(ENV)).not.toContain("Agent reading this");
    });
});
