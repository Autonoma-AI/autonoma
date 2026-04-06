import { type Logger, logger } from "@autonoma/logger";
import { Resend } from "resend";
import type { ChannelResult } from "./signup-hooks";

const FONT_FAMILY = "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const WEBSITE_URL = "https://www.getautonoma.com";
const BRAND = {
    background: "#050505",
    surface: "#141414",
    surfaceRaised: "#1A1A1A",
    border: "#2A2A2A",
    borderStrong: "#333333",
    text: "#EDEDED",
    muted: "#888888",
    accent: "#C2E812",
    accentForeground: "#050505",
} as const;
const LOGO_LARGE_URL = "https://www.getautonoma.com/logo-large.svg";

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

export class ResendOnboardingService {
    private readonly logger: Logger;
    private readonly client: Resend;

    constructor(
        apiKey: string,
        private readonly audienceId: string,
        private readonly fromEmail: string,
        private readonly calLink: string,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
        this.client = new Resend(apiKey);
    }

    async addToNewsletterAudience(params: { email: string; firstName?: string; lastName?: string }): Promise<void> {
        this.logger.info("Adding user to Resend newsletter audience", {
            email: params.email,
            audienceId: this.audienceId,
        });

        await this.client.contacts.create({
            audienceId: this.audienceId,
            email: params.email,
            firstName: params.firstName,
            lastName: params.lastName,
        });

        this.logger.info("User added to newsletter audience", { email: params.email });
    }

    async sendWelcomeEmail(params: { email: string; userName: string; channelResult?: ChannelResult }): Promise<void> {
        this.logger.info("Sending welcome email", { email: params.email });

        await this.client.emails.send({
            from: this.fromEmail,
            to: params.email,
            subject: "Welcome to Autonoma - Book your free onboarding session",
            html: this.buildWelcomeEmailHtml(params.userName, params.channelResult),
        });

        this.logger.info("Welcome email sent", { email: params.email });
    }

    private buildWelcomeEmailHtml(userName: string, channelResult?: ChannelResult): string {
        const safeUserName = escapeHtml(userName);
        const communitySection = this.buildCommunitySection(channelResult);
        const onboardingCard =
            channelResult?.type === "discord"
                ? ""
                : `
                    <div style="background-color: ${BRAND.background}; border: 1px solid ${BRAND.borderStrong}; padding: 16px 18px; margin: 0 0 28px 0;">
                        <p style="color: ${BRAND.accent}; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; margin: 0 0 8px 0; font-family: ${FONT_FAMILY};">Included in onboarding</p>
                        <p style="color: ${BRAND.text}; font-size: 15px; line-height: 24px; margin: 0; font-family: ${FONT_FAMILY};">Environment setup, test coverage guidance, and a direct walkthrough of your first successful Autonoma runs.</p>
                    </div>`;

        return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="dark">
    <meta name="supported-color-schemes" content="dark">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous">
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
</head>
<body style="background-color: ${BRAND.background}; font-family: ${FONT_FAMILY}; margin: 0; padding: 32px 16px;">
    <div style="width: 100%; max-width: 600px; margin: 0 auto;">
        <div style="background-color: ${BRAND.surface}; border: 1px solid ${BRAND.border};">
            <div style="height: 4px; background-color: ${BRAND.accent};"></div>

            <div style="padding: 28px 32px; border-bottom: 1px solid ${BRAND.border};">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                        <td valign="middle">
                            <img src="${LOGO_LARGE_URL}" alt="Autonoma logo" width="180" style="display: block; width: 180px; max-width: 100%; height: auto;">
                        </td>
                        <td align="right" valign="middle">
                            <a href="${WEBSITE_URL}" style="color: ${BRAND.text}; text-decoration: none; font-size: 11px; font-weight: 500; letter-spacing: 0.12em; font-family: ${FONT_FAMILY}; text-transform: uppercase; white-space: nowrap;">Visit website</a>
                        </td>
                    </tr>
                </table>
            </div>

            <div style="padding: 40px 32px 20px 32px; background-color: ${BRAND.surface};">
                <p style="color: ${BRAND.accent}; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; margin: 0 0 16px 0; font-family: ${FONT_FAMILY};">Onboarding</p>
                <h1 style="color: ${BRAND.text}; font-size: 34px; line-height: 1.15; font-weight: 700; margin: 0 0 16px 0; font-family: ${FONT_FAMILY};">Welcome to Autonoma</h1>
                <p style="color: ${BRAND.muted}; font-size: 16px; line-height: 26px; margin: 0; font-family: ${FONT_FAMILY};">Let's get your team set up to run end-to-end testing with real browsers and devices.</p>
            </div>

            <div style="padding: 20px 32px 40px 32px;">
                <div style="background-color: ${BRAND.surfaceRaised}; border: 1px solid ${BRAND.border}; padding: 28px;">
                    <p style="color: ${BRAND.text}; font-size: 18px; font-weight: 600; margin: 0 0 20px 0; font-family: ${FONT_FAMILY}; line-height: 1.5;">Hi ${safeUserName}, thanks for signing up.</p>

                    <p style="color: ${BRAND.text}; font-size: 16px; line-height: 26px; margin: 0 0 16px 0; font-family: ${FONT_FAMILY};">We're excited to help you automate your end-to-end testing. To get the most out of Autonoma, we'd love to offer you a free onboarding session with our team.</p>

                    <p style="color: ${BRAND.muted}; font-size: 15px; line-height: 24px; margin: 0 0 24px 0; font-family: ${FONT_FAMILY};">We'll walk you through setup, answer your questions, and make sure you're getting useful signal from your first runs as quickly as possible.</p>

                    ${onboardingCard}

                    <div style="margin: 0;">
                        <a href="${this.calLink}" style="background-color: ${BRAND.accent}; color: ${BRAND.accentForeground}; padding: 14px 22px; text-decoration: none; font-size: 14px; font-weight: 700; font-family: ${FONT_FAMILY}; display: inline-block;">Book your free onboarding session</a>
                    </div>

                    ${communitySection}

                    <p style="color: ${BRAND.muted}; font-size: 14px; margin: 28px 0 0 0; font-family: ${FONT_FAMILY}; line-height: 22px;">If you have any questions in the meantime, just reply to this email.</p>
                </div>
            </div>
        </div>
    </div>
</body>
</html>`;
    }

    private buildCommunitySection(channelResult?: ChannelResult): string {
        if (channelResult == null) return "";

        if (channelResult.type === "discord" && channelResult.inviteUrl != null) {
            return `
            <div style="margin-top: 28px; padding-top: 28px; border-top: 1px solid ${BRAND.border};">
                <p style="color: ${BRAND.accent}; font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700; margin: 0 0 10px 0; font-family: ${FONT_FAMILY};">Community</p>
                <h2 style="color: ${BRAND.text}; font-size: 22px; font-weight: 700; line-height: 1.3; margin: 0 0 12px 0; font-family: ${FONT_FAMILY};">Join our Discord server</h2>
                <p style="color: ${BRAND.muted}; font-size: 15px; line-height: 24px; margin: 0 0 18px 0; font-family: ${FONT_FAMILY};">Join our Discord community to get direct support, share feedback, and stay close to product updates.</p>
                <a href="${channelResult.inviteUrl}" style="background-color: transparent; color: ${BRAND.accent}; padding: 12px 20px; text-decoration: none; font-size: 14px; font-weight: 700; font-family: ${FONT_FAMILY}; display: inline-block; border: 1px solid ${BRAND.accent}; vertical-align: middle; line-height: 1;">Join our Discord server</a>
            </div>`;
        }

        if (channelResult.type === "slack") {
            return `
            <div style="margin-top: 28px; padding-top: 28px; border-top: 1px solid ${BRAND.border};">
                <p style="color: ${BRAND.accent}; font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700; margin: 0 0 10px 0; font-family: ${FONT_FAMILY};">Support</p>
                <h2 style="color: ${BRAND.text}; font-size: 22px; font-weight: 700; line-height: 1.3; margin: 0 0 12px 0; font-family: ${FONT_FAMILY};">Your dedicated Slack channel is ready</h2>
                <p style="color: ${BRAND.muted}; font-size: 15px; line-height: 24px; margin: 0; font-family: ${FONT_FAMILY};">We've created a dedicated Slack channel for your team. Check your Slack workspace for direct access to our support team.</p>
            </div>`;
        }

        return "";
    }
}
