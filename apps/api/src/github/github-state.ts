import { createHmac, timingSafeEqual } from "node:crypto";

/** How long an install link stays valid. Exported so a caller can tell an agent when to stop waiting. */
export const INSTALL_STATE_TTL_MS = 15 * 60 * 1000;

function getSecret(): string {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (secret == null) throw new Error("BETTER_AUTH_SECRET is not set");
    return secret;
}

export function createInstallState(organizationId: string, returnPath?: string): string {
    const payload = Buffer.from(
        JSON.stringify({ organizationId, returnPath, exp: Date.now() + INSTALL_STATE_TTL_MS }),
    ).toString("base64url");
    const sig = createHmac("sha256", getSecret()).update(payload).digest("hex");
    return `${payload}.${sig}`;
}

export type InstallStatePayload = {
    organizationId: string;
    returnPath?: string;
};

export function verifyInstallState(state: string): InstallStatePayload | undefined {
    const dotIndex = state.lastIndexOf(".");
    if (dotIndex === -1) return undefined;

    const payload = state.slice(0, dotIndex);
    const sig = state.slice(dotIndex + 1);

    const expectedSig = createHmac("sha256", getSecret()).update(payload).digest("hex");

    const sigBuffer = Buffer.from(sig, "hex");
    const expectedBuffer = Buffer.from(expectedSig, "hex");
    if (sigBuffer.length !== expectedBuffer.length) return undefined;
    if (!timingSafeEqual(sigBuffer, expectedBuffer)) return undefined;

    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
        organizationId: string;
        returnPath?: string;
        exp: number;
    };

    if (parsed.exp < Date.now()) return undefined;

    return { organizationId: parsed.organizationId, returnPath: parsed.returnPath };
}
