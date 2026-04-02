import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SlackMessage } from "../src/slack-message-builder";
import { SlackNotifier } from "../src/slack-notifier";

const WEBHOOK_URL = "https://hooks.slack.com/services/T00/B00/xxx";

const samplePayload: SlackMessage = {
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "test" } }],
};

function createMockFetch(responses: Array<{ ok: boolean; status: number } | Error>) {
    let callIndex = 0;
    return vi.fn(async () => {
        const response = responses[callIndex++];
        if (response instanceof Error) throw response;
        return response as Response;
    });
}

describe("SlackNotifier", () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    test("sends POST to webhook URL with correct headers and body", async () => {
        const mockFetch = createMockFetch([{ ok: true, status: 200 }]);
        vi.stubGlobal("fetch", mockFetch);

        const notifier = new SlackNotifier({ webhookUrl: WEBHOOK_URL });
        await notifier.send(samplePayload);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(WEBHOOK_URL);
        expect(options.method).toBe("POST");
        expect(options.headers).toEqual({ "Content-Type": "application/json" });
        expect(options.body).toBe(JSON.stringify(samplePayload));
    });

    test("succeeds on 200 response without throwing", async () => {
        vi.stubGlobal("fetch", createMockFetch([{ ok: true, status: 200 }]));

        const notifier = new SlackNotifier({ webhookUrl: WEBHOOK_URL });
        await expect(notifier.send(samplePayload)).resolves.toBeUndefined();
    });

    test("retries on 500 and succeeds on second attempt", async () => {
        const mockFetch = createMockFetch([
            { ok: false, status: 500 },
            { ok: true, status: 200 },
        ]);
        vi.stubGlobal("fetch", mockFetch);

        const notifier = new SlackNotifier({ webhookUrl: WEBHOOK_URL, maxRetries: 2 });
        await notifier.send(samplePayload);

        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("throws after exhausting all retries", async () => {
        vi.stubGlobal(
            "fetch",
            createMockFetch([
                { ok: false, status: 500 },
                { ok: false, status: 500 },
                { ok: false, status: 500 },
            ]),
        );

        const notifier = new SlackNotifier({ webhookUrl: WEBHOOK_URL, maxRetries: 2 });
        await expect(notifier.send(samplePayload)).rejects.toThrow("Slack webhook returned status 500");
    });

    test("retries on network error and throws after exhausting retries", async () => {
        vi.stubGlobal(
            "fetch",
            createMockFetch([new Error("Network failure"), new Error("Network failure"), new Error("Network failure")]),
        );

        const notifier = new SlackNotifier({ webhookUrl: WEBHOOK_URL, maxRetries: 2 });
        await expect(notifier.send(samplePayload)).rejects.toThrow("Network failure");
    });

    test("succeeds after network error on retry", async () => {
        const mockFetch = createMockFetch([new Error("Network failure"), { ok: true, status: 200 }]);
        vi.stubGlobal("fetch", mockFetch);

        const notifier = new SlackNotifier({ webhookUrl: WEBHOOK_URL, maxRetries: 2 });
        await notifier.send(samplePayload);

        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});
