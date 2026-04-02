import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { SlackNotifier, buildSlackRunCompletionMessage } from "@autonoma/notification";
import { env } from "../env";

export async function handleRunExit(runId: string): Promise<void> {
    logger.info("Handling run exit notification", { runId });

    const run = await db.run.findUnique({
        where: { id: runId },
        select: {
            status: true,
            reasoning: true,
            assignment: {
                select: {
                    testCase: {
                        select: {
                            name: true,
                            application: {
                                select: {
                                    name: true,
                                    slug: true,
                                    notificationConfigs: {
                                        where: { channel: "SLACK", enabled: true },
                                        select: { slackWebhookUrl: true },
                                    },
                                },
                            },
                        },
                    },
                    snapshot: {
                        select: {
                            branch: { select: { name: true } },
                        },
                    },
                },
            },
        },
    });

    if (run == null) {
        logger.warn("Notification skipped - run not found", { runId });
        return;
    }

    const slackConfigs = run.assignment.testCase.application.notificationConfigs;
    if (slackConfigs.length === 0) {
        logger.info("No Slack notification channels configured for application", { runId });
        return;
    }

    const appSlug = run.assignment.testCase.application.slug;
    const branchName = run.assignment.snapshot.branch.name;
    const runUrl = `${env.APP_URL}/app/${appSlug}/branch/${encodeURIComponent(branchName)}/runs/${runId}`;

    const status = run.status === "success" ? ("success" as const) : ("failed" as const);
    const payload = buildSlackRunCompletionMessage({
        testName: run.assignment.testCase.name,
        applicationName: run.assignment.testCase.application.name,
        status,
        reasoning: run.reasoning ?? undefined,
        runUrl,
    });

    for (const config of slackConfigs) {
        if (config.slackWebhookUrl == null) continue;

        const notifier = new SlackNotifier({ webhookUrl: config.slackWebhookUrl });
        await notifier.send(payload);
    }

    logger.info("Run exit Slack notifications sent", { runId, status, channelCount: slackConfigs.length });
}
