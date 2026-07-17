import { env } from "env";

/**
 * The API origin for data-plane calls that must bypass CloudFront: the app
 * host (autonoma.app) sits behind CloudFront, whose WAF/buffering can 403 or
 * mangle request bodies (a large `apply_config` document, a password
 * containing characters that trip injection rules) and interfere with
 * streaming HTTP. `api.<app-host>` is direct to the ALB, off CloudFront.
 * Localhost and per-PR previews reach the API cross-origin at VITE_API_URL.
 * Session cookies and OAuth are unaffected by which origin the data plane
 * uses - crossSubDomainCookies covers both.
 */
export function getApiOrigin(): string {
    const isPreview = window.location.hostname.endsWith(`.preview.${env.VITE_INTERNAL_DOMAIN}`);
    const isLocalhost = window.location.hostname === "localhost";
    return isPreview || isLocalhost ? env.VITE_API_URL : `https://api.${window.location.hostname}`;
}
