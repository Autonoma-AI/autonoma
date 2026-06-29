/**
 * Fixed convention: the Autonoma SDK / diff webhook lives at
 * `<preview>/api/autonoma`. Single source of truth so the dry-run targets
 * controller and the deployment-signal diff trigger never drift apart.
 */
export function buildSdkUrl(previewUrl: string): string {
    return `${previewUrl.replace(/\/$/, "")}/api/autonoma`;
}
