import { describe, expect, it } from "vitest";
import { PreviewEnvironment } from "../../src/preview/preview-environment";

const secrets = {
    getEnvVarNames: async () => ["DATABASE_URL", "STRIPE_KEY", "FIREBASE_KEY"],
    getEnvValues: async () => ({ FOO: "bar" }),
};

describe("PreviewEnvironment", () => {
    it("filters env var names case-insensitively", async () => {
        const preview = new PreviewEnvironment(secrets, "org/repo");
        expect(await preview.getEnvVarNames("key")).toEqual(["STRIPE_KEY", "FIREBASE_KEY"]);
        expect(await preview.getEnvVarNames()).toHaveLength(3);
    });

    it("runs a node script with the preview env injected and returns its stdout", async () => {
        const preview = new PreviewEnvironment(secrets, "org/repo");
        const output = await preview.runScript({ script: "console.log('value:' + process.env.FOO)" });
        expect(output).toContain("value:bar");
    });

    it("surfaces a script failure with its stderr", async () => {
        const preview = new PreviewEnvironment(secrets, "org/repo");
        await expect(preview.runScript({ script: "throw new Error('boom')" })).rejects.toThrow(/boom/);
    });
});
