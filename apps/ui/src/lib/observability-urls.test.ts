import { describe, expect, it } from "vitest";
import { buildSentryLogsUrl, buildTemporalWorkflowUrl } from "./observability-urls";

describe("buildTemporalWorkflowUrl", () => {
    it("builds a workflow URL with run id", () => {
        expect(
            buildTemporalWorkflowUrl({
                baseUrl: "https://temporal.example.com",
                namespace: "alpha-21852696",
                workflowId: "run-replay-cmpg2x1f200080nugkqz251ny",
                runId: "019e4cb7-1846-726b-ad3f-de2ae4607358",
            }),
        ).toBe(
            "https://temporal.example.com/namespaces/alpha-21852696/workflows/run-replay-cmpg2x1f200080nugkqz251ny/019e4cb7-1846-726b-ad3f-de2ae4607358",
        );
    });

    it("omits the run id segment when not provided", () => {
        expect(
            buildTemporalWorkflowUrl({
                baseUrl: "https://temporal.example.com/",
                namespace: "default",
                workflowId: "wf-1",
            }),
        ).toBe("https://temporal.example.com/namespaces/default/workflows/wf-1");
    });
});

describe("buildSentryLogsUrl", () => {
    it("matches the URL pattern used by the Sentry logs explorer", () => {
        const url = buildSentryLogsUrl({
            baseUrl: "https://sentry.autonoma.app",
            environment: "alpha-21852696",
            filterField: "snapshotId",
            filterValue: "cmpg2u72500090159egq0xxdm",
        });
        expect(url).toContain("https://sentry.autonoma.app/organizations/agent/explore/logs/?");
        expect(url).toContain("environment=alpha-21852696");
        expect(url).toContain("logsFields=timestamp");
        expect(url).toContain("logsFields=message");
        expect(url).toContain("logsQuery=snapshotId%3Acmpg2u72500090159egq0xxdm");
        expect(url).toContain("logsSortBys=-timestamp");
        expect(url).toContain("project=29");
        expect(url).toContain("project=25");
        expect(url).toContain("project=31");
        expect(url).toContain("statsPeriod=7d");
    });

    it("supports any canonical field name", () => {
        const url = buildSentryLogsUrl({
            baseUrl: "https://sentry.autonoma.app",
            environment: "production",
            filterField: "runId",
            filterValue: "cmpg3juxo002s0n79ilo87kyn",
        });
        expect(url).toContain("logsQuery=runId%3Acmpg3juxo002s0n79ilo87kyn");
    });
});
