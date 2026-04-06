import { createHmac, timingSafeEqual } from "node:crypto";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    type AuthPayload,
    type DownRequest,
    DownResponseSchema,
    type ScenarioWebhookRequest,
    ScenarioWebhookRequestSchema,
    UpResponseSchema,
} from "@autonoma/types";
import { RefsTokenSigner } from "./refs-token-signer";
import { getHeaderValue } from "./request-headers";

const DEFAULT_EXPIRES_IN_SECONDS = 2 * 60 * 60;

export interface EnvironmentFactoryUpContext {
    scenarioName: string;
    testRunId: string;
}

export interface EnvironmentFactoryDownContext {
    refs?: unknown;
    scenarioName: string;
    testRunId: string;
}

export interface EnvironmentFactoryUpResult {
    auth?: AuthPayload;
    expiresInSeconds?: number;
    metadata?: unknown;
    refs?: unknown;
}

interface EnvironmentFactoryScenarioFingerprintContext {
    scenarioName: string;
}

type EnvironmentFactoryFingerprint =
    | string
    | ((context: EnvironmentFactoryScenarioFingerprintContext) => Promise<string | undefined> | string | undefined);

export interface EnvironmentFactoryScenario {
    description?: string;
    fingerprint?: EnvironmentFactoryFingerprint;
    name: string;
    down(context: EnvironmentFactoryDownContext): Promise<{ ok: boolean } | void>;
    up(context: EnvironmentFactoryUpContext): Promise<EnvironmentFactoryUpResult>;
}

export interface EnvironmentFactoryConfig {
    allowInProduction?: boolean;
    environment?: string;
    internalSecret: string;
    logger?: Logger;
    scenarios: EnvironmentFactoryScenario[];
    sharedSecret: string;
}

export interface EnvironmentFactoryRawRequest {
    headers: Headers | Record<string, string | string[] | undefined>;
    method: string;
    rawBody: string;
}

export interface EnvironmentFactoryRawResponse {
    body: string;
    headers: Record<string, string>;
    status: number;
}

export class EnvironmentFactoryServer {
    private readonly logger: Logger;
    private readonly refsTokenSigner: RefsTokenSigner;
    private readonly scenariosByName: Map<string, EnvironmentFactoryScenario>;

    constructor(private readonly config: EnvironmentFactoryConfig) {
        this.logger = (config.logger ?? rootLogger).child({ name: this.constructor.name });
        this.refsTokenSigner = new RefsTokenSigner(config.internalSecret);
        this.scenariosByName = this.buildScenarioMap(config.scenarios);
    }

    public async handle(request: EnvironmentFactoryRawRequest): Promise<EnvironmentFactoryRawResponse> {
        this.logger.info("Handling environment factory request", { method: request.method });

        if (this.isDisabledInProduction()) {
            this.logger.info("Environment factory disabled in production");
            return {
                body: "",
                headers: {},
                status: 404,
            };
        }

        if (request.method.toUpperCase() !== "POST") {
            this.logger.warn("Rejected non-POST environment factory request", { method: request.method });
            return this.createErrorResponse(405, "METHOD_NOT_ALLOWED", "Only POST is supported", {
                Allow: "POST",
            });
        }

        const signature = getHeaderValue(request.headers, "x-signature");
        if (signature == null || !this.signatureIsValid(request.rawBody, signature)) {
            this.logger.warn("Rejected request with invalid signature");
            return this.createErrorResponse(401, "INVALID_SIGNATURE", "Invalid or missing signature");
        }

        const [body, parseError] = this.parseRequestBody(request.rawBody);
        if (parseError != null) {
            this.logger.warn("Rejected request with invalid body", { error: parseError.message });
            return this.createErrorResponse(400, "INVALID_REQUEST", parseError.message);
        }

        const response = await this.routeRequest(body);
        this.logger.info("Handled environment factory request", {
            action: body.action,
            status: response.status,
        });

        return response;
    }

    public async handleRequest(request: Request): Promise<Response> {
        this.logger.info("Handling fetch-style environment factory request");

        const rawBody = await request.text();
        const result = await this.handle({
            headers: request.headers,
            method: request.method,
            rawBody,
        });

        const body = result.body.length > 0 ? result.body : undefined;
        return new Response(body, {
            headers: result.headers,
            status: result.status,
        });
    }

    private buildScenarioMap(scenarios: EnvironmentFactoryScenario[]): Map<string, EnvironmentFactoryScenario> {
        const scenarioMap = new Map<string, EnvironmentFactoryScenario>();

        for (const scenario of scenarios) {
            if (scenarioMap.has(scenario.name)) {
                throw new Error(`Duplicate environment factory scenario "${scenario.name}"`);
            }

            scenarioMap.set(scenario.name, scenario);
        }

        return scenarioMap;
    }

    private createErrorResponse(
        status: number,
        code: string,
        message: string,
        extraHeaders?: Record<string, string>,
    ): EnvironmentFactoryRawResponse {
        const headers = {
            "content-type": "application/json",
            ...extraHeaders,
        };

        return {
            body: JSON.stringify({ code, error: message }),
            headers,
            status,
        };
    }

    private createJsonResponse(status: number, body: unknown): EnvironmentFactoryRawResponse {
        return {
            body: JSON.stringify(body),
            headers: {
                "content-type": "application/json",
            },
            status,
        };
    }

    private async createScenarioDescriptor(scenario: EnvironmentFactoryScenario): Promise<{
        description?: string;
        fingerprint?: string;
        name: string;
    }> {
        const fingerprint = await this.resolveFingerprint(scenario);
        return {
            description: scenario.description,
            fingerprint,
            name: scenario.name,
        };
    }

    private async handleDiscover(): Promise<EnvironmentFactoryRawResponse> {
        this.logger.info("Discovering environment factory scenarios");

        const environments = await Promise.all(
            Array.from(this.scenariosByName.values()).map((scenario) => this.createScenarioDescriptor(scenario)),
        );

        return this.createJsonResponse(200, {
            environments,
        });
    }

    private async handleDown(request: DownRequest): Promise<EnvironmentFactoryRawResponse> {
        this.logger.info("Handling environment factory down request", { testRunId: request.testRunId });

        if (request.refsToken == null) {
            return this.createErrorResponse(400, "MISSING_REFS_TOKEN", "refsToken is required for down");
        }

        const [verifiedToken, verifyError] = this.verifyRefsToken(request);
        if (verifyError != null) {
            this.logger.warn("Rejected down request with invalid refs token", { error: verifyError.message });
            return this.createErrorResponse(403, "INVALID_REFS_TOKEN", verifyError.message);
        }

        const scenario = this.scenariosByName.get(verifiedToken.scenarioName);
        if (scenario == null) {
            return this.createErrorResponse(
                400,
                "UNKNOWN_ENVIRONMENT",
                `Unknown environment: ${verifiedToken.scenarioName}`,
            );
        }

        const downResult = await scenario.down({
            refs: verifiedToken.refs,
            scenarioName: verifiedToken.scenarioName,
            testRunId: verifiedToken.testRunId,
        });

        const response = downResult ?? { ok: true };
        const parsedResponse = DownResponseSchema.parse(response);
        return this.createJsonResponse(200, parsedResponse);
    }

    private async handleUp(testRunId: string, scenarioName: string): Promise<EnvironmentFactoryRawResponse> {
        this.logger.info("Handling environment factory up request", { scenarioName, testRunId });

        const scenario = this.scenariosByName.get(scenarioName);
        if (scenario == null) {
            return this.createErrorResponse(400, "UNKNOWN_ENVIRONMENT", `Unknown environment: ${scenarioName}`);
        }

        const upResult = await scenario.up({ scenarioName, testRunId });
        const expiresInSeconds = upResult.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
        const refsToken = this.refsTokenSigner.sign({
            expiresInSeconds,
            refs: upResult.refs,
            scenarioName,
            testRunId,
        });

        const parsedResponse = UpResponseSchema.parse({
            auth: upResult.auth,
            expiresInSeconds,
            metadata: upResult.metadata,
            refs: upResult.refs,
            refsToken,
        });

        return this.createJsonResponse(200, parsedResponse);
    }

    private isDisabledInProduction(): boolean {
        const isProduction = this.config.environment === "production";
        return isProduction && !this.config.allowInProduction;
    }

    private parseRequestBody(rawBody: string): [ScenarioWebhookRequest, undefined] | [undefined, Error] {
        try {
            const parsedBody = JSON.parse(rawBody) as unknown;
            return [ScenarioWebhookRequestSchema.parse(parsedBody), undefined];
        } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid request body";
            return [undefined, new Error(message)];
        }
    }

    private async resolveFingerprint(scenario: EnvironmentFactoryScenario): Promise<string | undefined> {
        if (scenario.fingerprint == null) {
            return undefined;
        }

        if (typeof scenario.fingerprint === "string") {
            return scenario.fingerprint;
        }

        return scenario.fingerprint({ scenarioName: scenario.name });
    }

    private async routeRequest(body: ScenarioWebhookRequest): Promise<EnvironmentFactoryRawResponse> {
        if (body.action === "discover") {
            return this.handleDiscover();
        }

        if (body.action === "up") {
            return this.handleUp(body.testRunId, body.environment);
        }

        return this.handleDown(body);
    }

    private signatureIsValid(rawBody: string, signature: string): boolean {
        const expectedSignature = createHmac("sha256", this.config.sharedSecret).update(rawBody).digest("hex");

        const actualBuffer = Buffer.from(signature);
        const expectedBuffer = Buffer.from(expectedSignature);

        if (actualBuffer.length !== expectedBuffer.length) {
            return false;
        }

        return timingSafeEqual(actualBuffer, expectedBuffer);
    }

    private verifyRefsToken(
        request: DownRequest,
    ): [ReturnType<RefsTokenSigner["verify"]>, undefined] | [undefined, Error] {
        try {
            return [
                this.refsTokenSigner.verify({
                    refs: request.refs,
                    refsToken: request.refsToken ?? "",
                    testRunId: request.testRunId,
                }),
                undefined,
            ];
        } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid refs token";
            return [undefined, new Error(message)];
        }
    }
}
