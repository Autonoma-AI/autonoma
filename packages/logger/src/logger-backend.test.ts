import { describe, expect, it, vi } from "vitest";
import { ConsoleLogger } from "./console-logger";
import { BackendLogger } from "./logger-backend";
import { withObservabilityContext } from "./observability-context";

describe("BackendLogger ALS integration", () => {
    it("flattens the ambient observability context into every log payload", () => {
        const console = new ConsoleLogger();
        const spy = vi.spyOn(console, "info").mockImplementation(() => {});
        const logger = new BackendLogger(console);

        withObservabilityContext(
            { snapshot: { snapshotId: "snap-a", headSha: "abc" }, branch: { branchId: "br-a" } },
            () => {
                logger.info("hello", { extra: { custom: 1 } });
            },
        );

        expect(spy).toHaveBeenCalledOnce();
        const payload = spy.mock.calls[0]?.[0];
        expect(payload).toMatchObject({
            snapshotId: "snap-a",
            headSha: "abc",
            branchId: "br-a",
            extra: { custom: 1 },
        });
    });

    it("call-site extra overrides ambient context for the same key", () => {
        const console = new ConsoleLogger();
        const spy = vi.spyOn(console, "info").mockImplementation(() => {});
        const logger = new BackendLogger(console);

        withObservabilityContext({ snapshot: { snapshotId: "ambient" } }, () => {
            logger.info("override", { snapshotId: "explicit" });
        });

        const payload = spy.mock.calls[0]?.[0];
        expect(payload).toMatchObject({ snapshotId: "explicit" });
    });

    it("child bindings carry through alongside ambient context", () => {
        const calls: Array<{ extra: Record<string, unknown>; message: string }> = [];
        class RecorderConsole extends ConsoleLogger {
            override info(extra: Record<string, unknown>, message: string): void {
                calls.push({ extra, message });
            }
            override child(): ConsoleLogger {
                return this;
            }
        }
        const recorder = new RecorderConsole();
        const logger = new BackendLogger(recorder).child({ name: "TestActor" });

        withObservabilityContext({ snapshot: { snapshotId: "snap-z" } }, () => {
            logger.info("with child");
        });

        expect(calls[0]?.extra).toMatchObject({ name: "TestActor", snapshotId: "snap-z" });
    });
});
