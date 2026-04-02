export interface RunCompletionData {
    testName: string;
    applicationName: string;
    status: "success" | "failed";
    reasoning?: string;
    runUrl: string;
}

interface SlackBlock {
    type: string;
    text?: { type: string; text: string; emoji?: boolean };
    elements?: Array<{ type: string; text?: { type: string; text: string }; url?: string }>;
}

export interface SlackMessage {
    blocks: SlackBlock[];
}

export function buildSlackRunCompletionMessage(data: RunCompletionData): SlackMessage {
    const isSuccess = data.status === "success";
    const emoji = isSuccess ? ":white_check_mark:" : ":x:";
    const statusText = isSuccess ? "Test Passed" : "Test Failed";

    const blocks: SlackBlock[] = [
        {
            type: "header",
            text: { type: "plain_text", text: `${emoji} ${statusText}`, emoji: true },
        },
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `*Test:* ${data.testName}\n*Application:* ${data.applicationName}`,
            },
        },
    ];

    if (!isSuccess && data.reasoning != null) {
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: `*Reasoning:* ${data.reasoning}` },
        });
    }

    blocks.push({
        type: "actions",
        elements: [
            {
                type: "button",
                text: { type: "plain_text", text: "View Run" },
                url: data.runUrl,
            },
        ],
    });

    return { blocks };
}
