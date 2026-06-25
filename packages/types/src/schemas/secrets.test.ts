import { describe, expect, it } from "vitest";
import { PREVIEWKIT_BUILTIN_ENV_VARS } from "./previewkit-builtins";
import { SecretItemSchema } from "./secrets";

describe("SecretItemSchema reserved keys", () => {
    it("accepts a normal key", () => {
        const result = SecretItemSchema.safeParse({ key: "STRIPE_API_KEY", value: "sk_live_x" });
        expect(result.success).toBe(true);
    });

    it("rejects every reserved built-in key with an explanatory message", () => {
        for (const { key } of PREVIEWKIT_BUILTIN_ENV_VARS) {
            const result = SecretItemSchema.safeParse({ key, value: "x" });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.issues[0]?.message).toBe(
                    `${key} is a reserved built-in variable and cannot be set.`,
                );
            }
        }
    });
});
