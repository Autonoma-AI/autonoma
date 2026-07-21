/**
 * Fixed convention: the Autonoma SDK / diff webhook lives at
 * `<preview>/api/autonoma`. Single source of truth so every diff-trigger path
 * (onboarding deployment-signal, Vercel, PreviewKit) derives the same webhook
 * URL from a preview origin.
 */
export function buildSdkUrl(previewUrl: string): string {
    return `${previewUrl.replace(/\/$/, "")}/api/autonoma`;
}
