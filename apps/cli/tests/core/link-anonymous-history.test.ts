import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The alias is what joins a machine's pre-onboarding CLI history to the person
 * PostHog knows about. It has to be sent, it has to be sent once, and the "once"
 * must not be spent by a run that could not send it.
 *
 * Asserted through the debug transcript rather than the network: it records what
 * was captured, and it is the same path production uses. Capture points at a
 * dead local port so telemetry counts as enabled without leaving the machine.
 */
const PERSON = "person-abc-123";
const DEAD_HOST = "http://127.0.0.1:1";

let home: string;
let debugFile: string;
const originalEnv = { ...process.env };

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "alias-home-"));
    debugFile = join(home, "transcript.jsonl");
    process.env.HOME = home;
    process.env.AUTONOMA_DISTINCT_ID = PERSON;
    process.env.AUTONOMA_DEBUG_FILE = debugFile;
    process.env.AUTONOMA_POSTHOG_HOST = DEAD_HOST;
    delete process.env.DONT_TRACK;
    vi.resetModules();
});

afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    process.env = { ...originalEnv };
    vi.clearAllMocks();
});

async function identifyEvents(): Promise<Record<string, unknown>[]> {
    const raw = await readFile(debugFile, "utf-8").catch(() => "");
    return raw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line))
        .filter((record) => record.kind === "event" && record.event === "$identify");
}

describe("linkAnonymousHistory", () => {
    test("announces the device -> person link, carrying the machine's anonymous id", async () => {
        const { linkAnonymousHistory } = await import("../../src/core/analytics");
        const { getDeviceId } = await import("../../src/core/session");
        const deviceId = getDeviceId();

        linkAnonymousHistory();

        const events = await identifyEvents();
        expect(events).toHaveLength(1);
        // Without this PostHog has no way to know the two ids are one entity.
        expect(events[0]?.$anon_distinct_id).toBe(deviceId);
        expect(deviceId).not.toBe(PERSON);
    });

    test("does not re-announce a link this machine has already made", async () => {
        const { linkAnonymousHistory } = await import("../../src/core/analytics");

        linkAnonymousHistory();
        linkAnonymousHistory();
        linkAnonymousHistory();

        expect(await identifyEvents()).toHaveLength(1);
    });

    test("says nothing when the run is anonymous - there is no person to link to", async () => {
        delete process.env.AUTONOMA_DISTINCT_ID;
        vi.resetModules();
        const { linkAnonymousHistory } = await import("../../src/core/analytics");

        linkAnonymousHistory();

        expect(await identifyEvents()).toHaveLength(0);
    });

    /**
     * Two real processes, because that is what this behaviour is about: the marker
     * is shared through the filesystem across separate runs, and an in-process
     * module reset cannot model one run's state ending. The first run is opted out
     * and must leave the marker unwritten; the second must therefore still link.
     */
    test("an opted-out run does not spend the one chance to make the link", async () => {
        // No top-level await: `tsx -e` evaluates as CJS.
        const script = 'import("./src/core/analytics.ts").then((a) => a.linkAnonymousHistory());';
        const base: NodeJS.ProcessEnv = {
            ...originalEnv,
            HOME: home,
            AUTONOMA_DISTINCT_ID: PERSON,
            AUTONOMA_DEBUG_FILE: debugFile,
            AUTONOMA_POSTHOG_HOST: DEAD_HOST,
        };
        delete base.DONT_TRACK;
        const markerPath = join(home, ".autonoma", ".aliased-to");
        const run = (env: NodeJS.ProcessEnv): void => {
            execFileSync("node_modules/.bin/tsx", ["-e", script], { env, stdio: "ignore" });
        };

        run({ ...base, DONT_TRACK: "1" });
        const afterOptedOut = await readFile(markerPath, "utf-8").catch(() => undefined);
        run(base);
        const afterOptedIn = await readFile(markerPath, "utf-8").catch(() => undefined);

        // Marking on the opted-out run would leave the opted-in one silent forever.
        expect(afterOptedOut).toBeUndefined();
        expect(afterOptedIn?.trim()).toBe(PERSON);
    }, 60_000);
});
