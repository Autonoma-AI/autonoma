import { describe, expect, it } from "vitest";
import { AGENT_TABS, stepsWithFallback, type AgentTab, type InstallSnippetInput } from "./connect-agent-snippets";

const KEY = "ask_testkey";

function input(): InstallSnippetInput {
    return {
        url: "https://api.autonoma.app/v1/mcp",
        serverName: "autonoma",
        prompt: "set up my previews, code ABC123",
        mintKey: () => Promise.resolve(KEY),
    };
}

/**
 * The credential has to reach the clipboard without reaching the screen. Both halves matter:
 * an agent handed a block on a machine with no browser needs the header to keep going, and a
 * screenshot of this screen must not leak a live key.
 */
describe("the remote fallback", () => {
    it.each(AGENT_TABS.filter((tab: AgentTab) => tab.fallbackOnFirstStep === true).map((tab: AgentTab) => tab.id))(
        "is copied but never displayed on the %s tab",
        async (tabId: string) => {
            const tab = AGENT_TABS.find((candidate: AgentTab) => candidate.id === tabId);
            if (tab == null) throw new Error(`no tab ${tabId}`);
            const [install] = stepsWithFallback(tab, input());
            if (install?.resolveCopyText == null) throw new Error(`${tabId} carries no fallback`);

            expect(install.code).not.toContain(KEY);
            const copied = await install.resolveCopyText();
            expect(copied).toContain(`Authorization   Bearer ${KEY}`);
            expect(copied).toContain(install.code);
        },
    );

    it("asks for a key once per block copied, so a caller can dedupe them", async () => {
        const asked: string[] = [];
        const shared: InstallSnippetInput = {
            ...input(),
            mintKey: () => {
                asked.push("mint");
                return Promise.resolve(KEY);
            },
        };
        const fallbackTabs = AGENT_TABS.filter((candidate: AgentTab) => candidate.fallbackOnFirstStep === true);
        for (const tab of fallbackTabs) {
            await stepsWithFallback(tab, shared)[0]?.resolveCopyText?.();
        }
        // One ask per copy, not one per tab rendered: nothing is requested until a block is
        // actually copied. Collapsing those asks to a single credential is the caller's job -
        // `ConnectAgentInstall` holds the in-flight promise - and is covered where it lives.
        expect(asked).toHaveLength(fallbackTabs.length);
    });
});
