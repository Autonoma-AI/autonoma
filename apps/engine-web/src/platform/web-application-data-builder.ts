import type { AuthPayload } from "@autonoma/types";
import { resolvePreviewkitBypassToken } from "./previewkit-bypass-token";
import { toPlaywrightCookies } from "./scenario-auth";
import type { WebApplicationData } from "./web-application-data";

interface BuildWebApplicationDataParams {
    url: string;
    file?: string;
    auth?: AuthPayload;
    customHeaders?: Record<string, string>;
}

/**
 * Assembles WebApplicationData from a deployment URL, upload file, and provisioned auth.
 */
export async function buildWebApplicationData({
    url,
    file,
    auth,
    customHeaders,
}: BuildWebApplicationDataParams): Promise<WebApplicationData> {
    const cookies = auth?.cookies != null ? toPlaywrightCookies(auth.cookies, url) : undefined;

    const bypassToken = await resolvePreviewkitBypassToken(url);

    const baseHeaders: Record<string, string> = {
        ...(auth?.headers ?? {}),
        ...(customHeaders ?? {}),
    };

    let headers: Record<string, string> | undefined;
    if (bypassToken != null) {
        headers = { ...baseHeaders, "x-previewkit-bypass": bypassToken };
    } else if (Object.keys(baseHeaders).length > 0) {
        headers = baseHeaders;
    }

    return { url, file, cookies, headers };
}
