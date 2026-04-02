const ALPHA_AGENT_ORIGIN = /^https:\/\/alpha-[a-f0-9]+\.alpha\.agent\.autonoma\.app$/;
const AGENT_ORIGIN = /^https:\/\/alpha-[a-f0-9]+\.agent\.autonoma\.app$/;

export function isAllowedOrigin(origin: string, allowedOrigins: string): boolean {
    const allowedOriginSet = new Set(
        allowedOrigins
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
    );

    return allowedOriginSet.has(origin) || ALPHA_AGENT_ORIGIN.test(origin) || AGENT_ORIGIN.test(origin);
}
