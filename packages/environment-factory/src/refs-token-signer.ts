import { createHmac, timingSafeEqual } from "node:crypto";

interface RefsTokenPayload {
    exp: number;
    iat: number;
    refs?: unknown;
    scenarioName: string;
    testRunId: string;
}

interface SignRefsTokenParams {
    expiresInSeconds: number;
    refs?: unknown;
    scenarioName: string;
    testRunId: string;
}

interface VerifyRefsTokenParams {
    refs?: unknown;
    refsToken: string;
    testRunId: string;
}

interface VerifiedRefsToken {
    refs?: unknown;
    scenarioName: string;
    testRunId: string;
}

export class RefsTokenSigner {
    constructor(private readonly secret: string) {}

    public sign(params: SignRefsTokenParams): string {
        const payload: RefsTokenPayload = {
            exp: this.getCurrentUnixTime() + params.expiresInSeconds,
            iat: this.getCurrentUnixTime(),
            refs: params.refs,
            scenarioName: params.scenarioName,
            testRunId: params.testRunId,
        };

        const header = this.encodeSegment({ alg: "HS256", typ: "JWT" });
        const body = this.encodeSegment(payload);
        const signature = this.createSignature(`${header}.${body}`);

        return `${header}.${body}.${signature}`;
    }

    public verify(params: VerifyRefsTokenParams): VerifiedRefsToken {
        const [encodedHeader, encodedBody, signature] = params.refsToken.split(".");

        if (encodedHeader == null || encodedBody == null || signature == null) {
            throw new Error("Invalid refs token");
        }

        const expectedSignature = this.createSignature(`${encodedHeader}.${encodedBody}`);
        if (!this.signaturesMatch(signature, expectedSignature)) {
            throw new Error("Invalid refs token signature");
        }

        const payload = this.decodePayload(encodedBody);

        if (payload.exp <= this.getCurrentUnixTime()) {
            throw new Error("Refs token expired");
        }

        if (payload.testRunId !== params.testRunId) {
            throw new Error("Refs token test run mismatch");
        }

        if (!this.refsMatch(payload.refs, params.refs)) {
            throw new Error("Refs token refs mismatch");
        }

        return {
            refs: payload.refs,
            scenarioName: payload.scenarioName,
            testRunId: payload.testRunId,
        };
    }

    private createSignature(input: string): string {
        return createHmac("sha256", this.secret).update(input).digest("base64url");
    }

    private decodePayload(encodedBody: string): RefsTokenPayload {
        const rawBody = Buffer.from(encodedBody, "base64url").toString("utf8");
        const parsedBody = JSON.parse(rawBody) as RefsTokenPayload;

        if (typeof parsedBody.exp !== "number") {
            throw new Error("Refs token is missing exp");
        }
        if (typeof parsedBody.iat !== "number") {
            throw new Error("Refs token is missing iat");
        }
        if (typeof parsedBody.scenarioName !== "string") {
            throw new Error("Refs token is missing scenarioName");
        }
        if (typeof parsedBody.testRunId !== "string") {
            throw new Error("Refs token is missing testRunId");
        }

        return parsedBody;
    }

    private encodeSegment(value: unknown): string {
        return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    }

    private getCurrentUnixTime(): number {
        return Math.floor(Date.now() / 1000);
    }

    private refsMatch(expectedRefs: unknown, actualRefs: unknown): boolean {
        return this.stableStringify(expectedRefs) === this.stableStringify(actualRefs);
    }

    private signaturesMatch(actualSignature: string, expectedSignature: string): boolean {
        const actualBuffer = Buffer.from(actualSignature);
        const expectedBuffer = Buffer.from(expectedSignature);

        if (actualBuffer.length !== expectedBuffer.length) {
            return false;
        }

        return timingSafeEqual(actualBuffer, expectedBuffer);
    }

    private stableStringify(value: unknown): string {
        return JSON.stringify(this.sortValue(value)) ?? "undefined";
    }

    private sortValue(value: unknown): unknown {
        if (Array.isArray(value)) {
            return value.map((item) => this.sortValue(item));
        }

        if (value == null || typeof value !== "object") {
            return value;
        }

        const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
        const sortedValue: Record<string, unknown> = {};

        for (const [key, entryValue] of entries) {
            sortedValue[key] = this.sortValue(entryValue);
        }

        return sortedValue;
    }
}
