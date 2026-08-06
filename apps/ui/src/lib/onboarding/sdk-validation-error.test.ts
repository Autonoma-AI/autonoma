import { describe, expect, it } from "vitest";
import { classifySdkValidationError } from "./sdk-validation-error";

/**
 * The messages here are the ones the platform actually persists into `lastDiscoveryError` - lifted
 * from `packages/scenario/test/sdk-client.test.ts` and `apps/api/test/onboarding/onboarding-manager.test.ts`.
 */
describe("classifySdkValidationError", () => {
    it.each([
        "SDK returned HTTP 404: Autonoma endpoint is disabled in production",
        "SDK returned HTTP 401: Invalid HMAC signature",
        "SDK returned HTTP 401: Unauthorized",
        'SDK returned HTTP 400: Invalid request body: no factory registered for model "external_connectors".',
        "SDK returned HTTP 500: code=INTERNAL_ERROR - the SDK endpoint returned an empty error message",
        "SDK discover response validation failed: models.0.name expected string",
    ])("treats %s as the user's own code", (message) => {
        expect(classifySdkValidationError(message)).toBe("fixable");
    });

    it.each([
        "SDK returned HTTP 503: Service is unavailable",
        "SDK returned HTTP 502: Bad Gateway",
        "SDK returned HTTP 504",
        "fetch failed: connect ECONNREFUSED 10.1.2.3:443",
        "fetch failed: socket hang up",
        "Discovery timed out or crashed. Please retry.",
        "SDK discover timed out after 90000ms",
    ])("treats %s as a preview that never answered", (message) => {
        expect(classifySdkValidationError(message)).toBe("transient");
    });

    it("lets the status win over a parse error, because a 404 serves an HTML page", () => {
        const message =
            "SDK returned HTTP 404: Error parsing response: Unexpected token '<', \"<html> <h\"... is not valid JSON";
        expect(classifySdkValidationError(message)).toBe("fixable");
    });

    it("reads a statusless parse error as an unresponsive preview", () => {
        const message = "Error parsing response: Unexpected token 'S', \"Service is\"... is not valid JSON";
        expect(classifySdkValidationError(message)).toBe("transient");
    });
});
