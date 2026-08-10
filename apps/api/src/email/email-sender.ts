import { type Logger, logger } from "@autonoma/logger";
import { Resend } from "resend";
import { LOGO_ATTACHMENT } from "./brand";

export interface OutgoingEmail {
    to: string;
    subject: string;
    html: string;
    /**
     * Who this particular message comes from, overriding the environment's default sender.
     *
     * Different kinds of mail want different senders, and the difference is not cosmetic: an
     * invitation should come from the product, while the onboarding email is a person asking for a
     * reply and would be undermined by a no-reply-looking address. One global `from` cannot be right
     * for both, so the message carries its own.
     */
    from?: string;
}

/**
 * The seam every transactional email goes through, so a caller never has to know whether a
 * provider is configured in this environment. Integration tests substitute a recorder.
 */
export interface EmailSender {
    send(email: OutgoingEmail): Promise<void>;
}

export class ResendEmailSender implements EmailSender {
    private readonly logger: Logger;
    private readonly client: Resend;

    constructor(
        apiKey: string,
        private readonly fromEmail: string,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
        this.client = new Resend(apiKey);
    }

    async send(email: OutgoingEmail): Promise<void> {
        const { to, subject, html } = email;
        this.logger.info("Sending email", { extra: { to, subject, from: email.from ?? this.fromEmail } });

        const result = await this.client.emails.send({
            from: email.from ?? this.fromEmail,
            to,
            subject,
            html,
            attachments: [LOGO_ATTACHMENT],
        });

        if (result.error != null) {
            this.logger.error("Resend rejected the email", { extra: { to, subject, error: result.error } });
            throw new Error(`Failed to send email: ${result.error.message}`);
        }

        this.logger.info("Email sent", { extra: { to, subject, id: result.data?.id } });
    }
}

/**
 * Stands in for a provider in environments with no `RESEND_API_KEY` (local dev, previewkit,
 * self-host). Logging at `warn` rather than throwing is deliberate: the invitation row is
 * already committed and the UI shows a copyable accept link, so a missing mail provider must
 * not fail the invite - it only means the invitee has to be handed the link some other way.
 */
export class LoggingEmailSender implements EmailSender {
    private readonly logger: Logger;

    constructor() {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async send({ to, subject, from }: OutgoingEmail): Promise<void> {
        this.logger.warn("No email provider configured - email not sent", { extra: { to, subject, from } });
    }
}

export function buildEmailSender(apiKey: string | undefined, fromEmail: string): EmailSender {
    if (apiKey == null) return new LoggingEmailSender();
    return new ResendEmailSender(apiKey, fromEmail);
}
