import { describe, expect, test, vi } from "vitest";
import { startApiServer } from "../../src/start-api-server";

describe("startApiServer", () => {
    test("logs readiness after the server binds successfully", () => {
        const info = vi.fn();
        const serve = vi.fn(() => ({ close: vi.fn() }));

        startApiServer({
            app: { fetch: vi.fn() },
            port: 4000,
            logger: { info },
            serve,
        });

        expect(serve).toHaveBeenCalledOnce();
        expect(info).toHaveBeenCalledWith("Server running on port 4000");
    });

    test("does not log readiness when binding throws", () => {
        const info = vi.fn();
        const serve = vi.fn(() => {
            throw new Error("EADDRINUSE");
        });

        expect(() =>
            startApiServer({
                app: { fetch: vi.fn() },
                port: 4000,
                logger: { info },
                serve,
            }),
        ).toThrow("EADDRINUSE");

        expect(info).not.toHaveBeenCalled();
    });
});
