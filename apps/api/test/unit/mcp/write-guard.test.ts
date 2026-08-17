import { describe, expect, it } from "vitest";
import { createWriteGuard } from "../../../src/mcp/write-guard";

interface LogEntry {
    tool: string;
    message: string;
    status?: string;
    error?: string;
}

/**
 * The half of {@link OnboardingAgentSessionService} the guard uses, recording what it was asked to
 * do so a test can tell a mutexed write from an unencumbered one by its effects.
 */
class FakeSession {
    public claims = 0;
    public entries: LogEntry[] = [];

    constructor(
        private readonly agentDriven: boolean,
        private readonly humanTookOver = false,
    ) {}

    async isAgentDriven(): Promise<boolean> {
        return this.agentDriven;
    }

    async claimForAgent() {
        this.claims++;
        if (this.humanTookOver) return { claimed: false, reason: "paused_by_user" };
        return { claimed: true };
    }

    async startLogEntry(_applicationId: string, tool: string, message: string): Promise<string> {
        this.entries.push({ tool, message });
        return String(this.entries.length - 1);
    }

    async finishLogEntry(
        _applicationId: string,
        entryId: string,
        outcome: { status: string; error?: string; message?: string },
    ): Promise<void> {
        const entry = this.entries[Number(entryId)];
        if (entry == null) throw new Error(`no log entry ${entryId}`);
        entry.status = outcome.status;
        entry.error = outcome.error;
        entry.message = outcome.message ?? entry.message;
    }
}

/**
 * The guard only reaches into the service graph for the session and (when a tool declares
 * `requires`) the app's preview path, so a stand-in carrying those two is the whole dependency.
 * Not typed as `Services`: every other service is unreachable from here by construction.
 */
function servicesWith(session: FakeSession) {
    return { onboardingAgentSession: session, onboarding: {} };
}

const WRITE = { applicationId: "app-1", organizationId: "org-1", tool: "apply_config", message: "Saving config" };

/** The single text content block of a tool result, parsed back from its JSON payload. */
function payloadOf(result: { content: unknown }): Record<string, unknown> {
    const content = result.content;
    if (!Array.isArray(content)) throw new Error("tool result has no content array");
    const first = content[0];
    if (first == null || first.type !== "text") throw new Error("tool result is not text content");
    return JSON.parse(first.text);
}

describe("createWriteGuard", () => {
    it("takes the mutex and streams the write when an agent is driving the application", async () => {
        const session = new FakeSession(true);
        const guard = createWriteGuard(servicesWith(session));

        const result = await guard(WRITE, async (organizationId) => ({ saved: true, organizationId }));

        expect(payloadOf(result)).toEqual({ saved: true, organizationId: "org-1" });
        expect(session.claims).toBe(1);
        expect(session.entries).toEqual([{ tool: "apply_config", message: "Saving config", status: "done" }]);
    });

    it("runs the same write untouched when nobody is configuring the application", async () => {
        const session = new FakeSession(false);
        const guard = createWriteGuard(servicesWith(session));

        const result = await guard(WRITE, async (organizationId) => ({ saved: true, organizationId }));

        expect(payloadOf(result)).toEqual({ saved: true, organizationId: "org-1" });
        expect(session.claims).toBe(0);
        expect(session.entries).toEqual([]);
    });

    it("stands the agent down without writing when the human has taken over", async () => {
        const session = new FakeSession(true, true);
        const guard = createWriteGuard(servicesWith(session));
        let ran = false;

        const result = await guard(WRITE, async () => {
            ran = true;
            return { saved: true };
        });

        expect(payloadOf(result)).toMatchObject({ status: "paused", standDown: true });
        expect(ran).toBe(false);
        expect(session.entries).toEqual([]);
    });

    it("relabels the activity entry with what the write actually did", async () => {
        const session = new FakeSession(true);
        const guard = createWriteGuard(servicesWith(session));

        await guard(
            {
                ...WRITE,
                message: "Deploying the base preview",
                describeOutcome: (result: { started: boolean }) =>
                    result.started ? undefined : "Left the deploy already in flight to finish",
            },
            async () => ({ started: false }),
        );

        expect(session.entries[0]?.message).toBe("Left the deploy already in flight to finish");
    });

    it("keeps the opening line when the write did what it announced", async () => {
        const session = new FakeSession(true);
        const guard = createWriteGuard(servicesWith(session));

        await guard(
            {
                ...WRITE,
                message: "Deploying the base preview",
                describeOutcome: (result: { started: boolean }) =>
                    result.started ? undefined : "Left the deploy already in flight to finish",
            },
            async () => ({ started: true }),
        );

        expect(session.entries[0]?.message).toBe("Deploying the base preview");
    });

    it("marks the activity entry failed when the write throws", async () => {
        const session = new FakeSession(true);
        const guard = createWriteGuard(servicesWith(session));

        const result = await guard(WRITE, async () => {
            throw new Error("config is invalid");
        });

        expect(result.isError).toBe(true);
        expect(session.entries[0]?.status).toBe("error");
        expect(session.entries[0]?.error).toContain("config is invalid");
    });
});
