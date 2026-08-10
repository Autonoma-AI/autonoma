import { BRAND, FONT_FAMILY, escapeHtml, renderBrandedEmail } from "../../email/brand";
import type { OutgoingEmail } from "../../email/email-sender";

interface InvitationEmailParams {
    to: string;
    /** Who it comes from - the product, not whoever the environment's default sender happens to be. */
    from: string;
    organizationName: string;
    inviterName: string;
    acceptUrl: string;
    expiresAt: Date;
}

function formatExpiry(expiresAt: Date): string {
    return expiresAt.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
    });
}

export function buildInvitationEmail({
    to,
    from,
    organizationName,
    inviterName,
    acceptUrl,
    expiresAt,
}: InvitationEmailParams): OutgoingEmail {
    const safeOrg = escapeHtml(organizationName);
    const safeInviter = escapeHtml(inviterName);

    return {
        to,
        from,
        subject: `${inviterName} invited you to ${organizationName} on Autonoma`,
        html: renderBrandedEmail({
            eyebrow: "Invitation",
            heading: `Join ${safeOrg}`,
            subheading: `${safeInviter} invited you to their Autonoma organization.`,
            contentHtml: `                    <p style="color: ${BRAND.text}; font-size: 16px; line-height: 26px; margin: 0 0 16px 0; font-family: ${FONT_FAMILY};">Autonoma runs your end-to-end tests against a preview deployment of every pull request, and reviews the result. Joining <strong style="color: ${BRAND.text};">${safeOrg}</strong> gives you access to its applications, test suites and runs.</p>

                    <p style="color: ${BRAND.muted}; font-size: 15px; line-height: 24px; margin: 0 0 24px 0; font-family: ${FONT_FAMILY};">If you already use Autonoma, joining adds this organization to your account - you keep the ones you're already in and can switch between them.</p>

                    <div style="margin: 0 0 24px 0;">
                        <a href="${acceptUrl}" style="background-color: ${BRAND.accent}; color: ${BRAND.accentForeground}; padding: 14px 22px; text-decoration: none; font-size: 14px; font-weight: 700; font-family: ${FONT_FAMILY}; display: inline-block;">Review invitation</a>
                    </div>

                    <p style="color: ${BRAND.muted}; font-size: 14px; line-height: 22px; margin: 0; font-family: ${FONT_FAMILY};">This invitation expires on ${formatExpiry(expiresAt)}. If you weren't expecting it, you can ignore this email.</p>`,
        }),
    };
}
