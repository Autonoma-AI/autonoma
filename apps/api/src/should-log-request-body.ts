const BODY_LOG_BLOCKLIST_PATHS = new Set(["/v1/stripe/webhook", "/v1/upload/package"]);
const BODY_LOG_METHODS = new Set(["POST", "PUT", "PATCH"]);

interface ShouldLogRequestBodyParams {
    method: string;
    path: string;
    contentType: string;
}

export function shouldLogRequestBody({ method, path, contentType }: ShouldLogRequestBodyParams): boolean {
    if (!BODY_LOG_METHODS.has(method)) return false;
    if (contentType.startsWith("multipart/form-data")) return false;
    if (BODY_LOG_BLOCKLIST_PATHS.has(path)) return false;
    return true;
}
