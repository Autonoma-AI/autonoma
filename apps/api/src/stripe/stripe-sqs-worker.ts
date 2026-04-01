import { processWebhookEvent } from "@autonoma/billing";
import { logger as rootLogger } from "@autonoma/logger";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient, type Message } from "@aws-sdk/client-sqs";
import * as Sentry from "@sentry/node";
import type Stripe from "stripe";

export class StripeSqsWorker {
    private readonly logger;
    private readonly client: SQSClient;
    private running = false;

    constructor(
        private readonly queueUrl: string,
        region: string,
        accessKeyId: string,
        secretAccessKey: string,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name, queueUrl });
        this.client = new SQSClient({
            region,
            credentials: { accessKeyId, secretAccessKey },
        });
    }

    start(): void {
        this.running = true;
        this.logger.info("StripeSqsWorker starting");
        void this.poll();
    }

    stop(): void {
        this.running = false;
        this.logger.info("StripeSqsWorker stopping");
    }

    private async poll(): Promise<void> {
        while (this.running) {
            try {
                const response = await this.client.send(
                    new ReceiveMessageCommand({
                        QueueUrl: this.queueUrl,
                        MaxNumberOfMessages: 10,
                        WaitTimeSeconds: 20,
                    }),
                );

                for (const message of response.Messages ?? []) {
                    await this.processMessage(message);
                }
            } catch (err) {
                this.logger.error("SQS poll error", { err });
                Sentry.captureException(err);
                await new Promise<void>((resolve) => setTimeout(resolve, 5000));
            }
        }

        this.logger.info("StripeSqsWorker stopped");
    }

    private async processMessage(message: Message): Promise<void> {
        this.logger.info("Processing SQS message", { messageId: message.MessageId });

        try {
            const body = JSON.parse(message.Body ?? "{}") as { event: Stripe.Event };
            const event = body.event;

            await processWebhookEvent(event);

            await this.client.send(
                new DeleteMessageCommand({
                    QueueUrl: this.queueUrl,
                    ReceiptHandle: message.ReceiptHandle,
                }),
            );

            this.logger.info("SQS message processed and deleted", {
                messageId: message.MessageId,
                eventId: event.id,
                eventType: event.type,
            });
        } catch (err) {
            this.logger.error("Failed to process SQS message - will retry on visibility timeout", {
                messageId: message.MessageId,
                err,
            });
            Sentry.captureException(err);
        }
    }
}
