import { LOGO_LARGE_BASE64 } from "../signup-hooks/assets/logo-large-base64";

export const FONT_FAMILY = "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
export const WEBSITE_URL = "https://www.getautonoma.com";
export const BRAND = {
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

/**
 * The logo travels as an attachment referenced by `cid:` rather than a hosted URL, because
 * most mail clients block remote images by default and the header would render empty.
 */
export const LOGO_CID = "autonoma-logo";

export const LOGO_ATTACHMENT = {
    content: LOGO_LARGE_BASE64,
    filename: "logo-large.png",
    contentId: LOGO_CID,
} as const;

export function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

interface BrandedEmail {
    /** Small uppercase kicker above the heading ("Onboarding", "Invitation"). */
    eyebrow: string;
    heading: string;
    subheading: string;
    /** Already-escaped HTML for the card body. */
    contentHtml: string;
}

/**
 * The shared outer chrome for every transactional email: dark card, accent rule, logo header.
 * Styles are inline and the layout is table-based where it has to be, because email clients
 * strip stylesheets and Outlook still needs tables for two-column rows.
 */
export function renderBrandedEmail({ eyebrow, heading, subheading, contentHtml }: BrandedEmail): string {
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
                            <img src="cid:${LOGO_CID}" alt="Autonoma logo" width="180" style="display: block; width: 180px; max-width: 100%; height: auto;">
                        </td>
                        <td align="right" valign="middle">
                            <a href="${WEBSITE_URL}" style="color: ${BRAND.text}; text-decoration: none; font-size: 11px; font-weight: 500; letter-spacing: 0.12em; font-family: ${FONT_FAMILY}; text-transform: uppercase; white-space: nowrap;">Visit website</a>
                        </td>
                    </tr>
                </table>
            </div>

            <div style="padding: 40px 32px 20px 32px; background-color: ${BRAND.surface};">
                <p style="color: ${BRAND.accent}; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; margin: 0 0 16px 0; font-family: ${FONT_FAMILY};">${eyebrow}</p>
                <h1 style="color: ${BRAND.text}; font-size: 34px; line-height: 1.15; font-weight: 700; margin: 0 0 16px 0; font-family: ${FONT_FAMILY};">${heading}</h1>
                <p style="color: ${BRAND.muted}; font-size: 16px; line-height: 26px; margin: 0; font-family: ${FONT_FAMILY};">${subheading}</p>
            </div>

            <div style="padding: 20px 32px 40px 32px;">
                <div style="background-color: ${BRAND.surfaceRaised}; border: 1px solid ${BRAND.border}; padding: 28px;">
${contentHtml}
                </div>
            </div>
        </div>
    </div>
</body>
</html>`;
}
