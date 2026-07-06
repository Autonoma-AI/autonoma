import { describe, expect, it } from "vitest";
import { heuristicFindings, maskSecretsInLine } from "../../../src/previewkit/previewkit-diagnosis.service";
import type { PreviewFailure } from "../../../src/routes/deployments/preview-summary";

describe("heuristicFindings", () => {
    it("maps a missing-path failure to a user_setup finding pointing at the config field", () => {
        const failures: PreviewFailure[] = [
            {
                code: "missing_path",
                message: 'No repo directory found for app "web"',
                appName: "web",
                fieldPath: "apps.0.path",
            },
        ];
        const { findings } = heuristicFindings(failures);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.category).toBe("user_setup");
        expect(findings[0]?.appName).toBe("web");
        expect(findings[0]?.fieldPath).toBe("apps.0.path");
        expect(findings[0]?.action).toBe("edit_config");
    });

    it("attributes an addon failure to Autonoma with a contact_support action", () => {
        const failures: PreviewFailure[] = [{ code: "addon_failed", message: "addon db failed to provision" }];
        const { findings } = heuristicFindings(failures);
        expect(findings[0]?.category).toBe("autonoma_error");
        expect(findings[0]?.action).toBe("contact_support");
    });

    it("keeps build/deploy failures user-owned but low confidence for the AI pass to reclassify", () => {
        const failures: PreviewFailure[] = [
            { code: "build_failed", message: "npm run build exited 1", appName: "web" },
        ];
        const { findings } = heuristicFindings(failures);
        expect(findings[0]?.category).toBe("user_setup");
        expect(findings[0]?.confidence).toBe("low");
    });

    it("falls back to a single unknown finding from the environment error when no failures were classified", () => {
        const { findings, summary } = heuristicFindings([], "namespace creation timed out");
        expect(findings).toHaveLength(1);
        expect(findings[0]?.category).toBe("unknown");
        expect(findings[0]?.explanation).toBe("namespace creation timed out");
        expect(summary).toContain("1 issue");
    });

    it("produces no findings when there is neither a classified failure nor an environment error", () => {
        expect(heuristicFindings([]).findings).toEqual([]);
    });
});

describe("maskSecretsInLine", () => {
    it("masks credentials embedded in a connection URL", () => {
        expect(maskSecretsInLine("connecting to postgres://user:sup3rs3cr3t@db:5432/app")).toBe(
            "connecting to postgres://user:***@db:5432/app",
        );
    });

    it("masks long high-entropy tokens", () => {
        const masked = maskSecretsInLine("AUTH_TOKEN=sk_live_0123456789abcdef0123456789abcdef");
        expect(masked).not.toContain("0123456789abcdef0123456789abcdef");
        expect(masked).toContain("***");
    });

    it("leaves ordinary log lines untouched", () => {
        const line = "Error: cannot find module ./config";
        expect(maskSecretsInLine(line)).toBe(line);
    });
});
