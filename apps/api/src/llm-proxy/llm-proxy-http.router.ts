import { requireApiKey, type UserAuthVariables } from "@autonoma/auth";
import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { Hono } from "hono";
import { z } from "zod";
import { billingService } from "../context";
import { env } from "../env";

const logger = rootLogger.child({ name: "llmProxyHttpRouter" });

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

// Upper bound on a single upstream request. Bounds a hung/stalled OpenRouter
// connection (which would otherwise hold the request and the detached meter
// drain open indefinitely) while staying well above any real planner call.
const UPSTREAM_TIMEOUT_MS = 300_000;

// Default allowlist - the only model the planner CLI uses. The proxy is a free,
// credit-metered gateway, so restricting the routable models is the main guard
// against it being used as a general-purpose LLM API. Override with the
// LLM_PROXY_ALLOWED_MODELS env var (comma-separated) without a deploy.
const LLM_PROXY_DEFAULT_MODELS = ["google/gemini-3-flash-preview"];

const configuredModels =
    env.LLM_PROXY_ALLOWED_MODELS?.split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0) ?? [];
// An empty/whitespace-only override falls back to the defaults rather than
// silently blocking every model with a 400.
const allowedModels = new Set(configuredModels.length > 0 ? configuredModels : LLM_PROXY_DEFAULT_MODELS);

// Accepts the OpenAI/OpenRouter chat-completions body but only pins the two
// fields we act on (`model` for the allowlist, `stream` for the response shape).
// `.passthrough()` preserves every other field so the request forwards verbatim.
const ChatCompletionsBodySchema = z
    .object({
        model: z.string(),
        stream: z.boolean().optional(),
    })
    .passthrough();

// Tolerant view over OpenRouter responses (streamed chunks and the non-streamed
// body) used only to pull the generation id and the usage cost for metering.
const UsageEnvelopeSchema = z
    .object({
        id: z.string().optional(),
        usage: z
            .object({
                cost: z.number().optional(),
                cost_details: z.object({ upstream_inference_cost: z.number().optional() }).passthrough().optional(),
            })
            .passthrough()
            .optional(),
    })
    .passthrough();

type CapturedUsage = { id?: string; cost?: number };

/**
 * The dollar cost OpenRouter actually incurred for a request. For BYOK
 * integrations OpenRouter reports `usage.cost = 0` (the spend lands on the
 * upstream provider key it holds for us), so fall back to the upstream inference
 * cost. Keeps metering correct in both BYOK and normal billing modes.
 */
function effectiveUsageCost(
    usage: { cost?: number; cost_details?: { upstream_inference_cost?: number } } | undefined,
): number | undefined {
    if (usage == null) return undefined;
    if (usage.cost != null && usage.cost > 0) return usage.cost;
    const upstream = usage.cost_details?.upstream_inference_cost;
    if (upstream != null && upstream > 0) return upstream;
    return undefined;
}

export const llmProxyHttpRouter = new Hono<{ Variables: UserAuthVariables }>();

llmProxyHttpRouter.use("*", requireApiKey({ db }));

llmProxyHttpRouter.post("/chat/completions", async (c) => {
    const { organizationId } = c.var.user;
    logger.info("LLM proxy request received", { organizationId });

    const apiKey = env.OPENROUTER_API_KEY;
    if (apiKey == null) {
        logger.error("LLM proxy is unconfigured - OPENROUTER_API_KEY is not set");
        return c.json({ error: "llm_proxy_unconfigured" }, 503);
    }

    const hasBalance = await billingService.hasPositiveCreditBalance(organizationId);
    if (!hasBalance) {
        logger.info("LLM proxy request blocked - out of credits", { organizationId });
        return c.json({ error: "out_of_credits", message: "You're out of Autonoma credits." }, 402);
    }

    const parsedBody = ChatCompletionsBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsedBody.success) {
        logger.warn("LLM proxy request rejected - invalid body", { organizationId });
        return c.json({ error: "invalid_request" }, 400);
    }

    const { model } = parsedBody.data;
    if (!allowedModels.has(model)) {
        logger.warn("LLM proxy request rejected - model not allowed", { organizationId, model });
        return c.json({ error: "model_not_allowed", model }, 400);
    }

    const isStreaming = parsedBody.data.stream === true;
    // Ask OpenRouter to include usage accounting (incl. dollar cost) so we can
    // meter. For streams this surfaces in a trailing chunk; non-stream in the body.
    const forwardBody = { ...parsedBody.data, usage: { include: true } };

    logger.info("Forwarding to OpenRouter", { organizationId, model, isStreaming });

    let upstream: Response;
    try {
        upstream = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "HTTP-Referer": "https://autonoma.app",
                "X-Title": "Autonoma Planner",
            },
            body: JSON.stringify(forwardBody),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
    } catch (err) {
        // Network failure or the timeout above firing. Don't leak detail to the
        // caller; the detached meter drain (if any) errors on the aborted body.
        logger.error("LLM proxy upstream request failed", { organizationId, model, err });
        return c.json({ error: "upstream_error" }, 502);
    }

    if (!upstream.ok || upstream.body == null) {
        // Don't leak OpenRouter's identity or our account's auth/rate-limit state
        // to the caller - log the upstream detail server-side, return a generic 502.
        const detail = await upstream.text().catch(() => "");
        logger.warn("OpenRouter returned an error", { organizationId, model, status: upstream.status, detail });
        return c.json({ error: "upstream_error" }, 502);
    }

    if (isStreaming) {
        // Tee the upstream stream: one branch streams to the client, the other we
        // drain ourselves for metering. Draining the meter branch independently
        // means we still capture usage (and bill) even if the client disconnects
        // mid-stream - tee keeps the source alive as long as one branch is read.
        const [clientBranch, meterBranch] = upstream.body.tee();
        void drainStreamForMetering(meterBranch, organizationId);
        return new Response(clientBranch, {
            status: upstream.status,
            headers: {
                "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        });
    }

    const rawText = await upstream.text();
    const parsed = UsageEnvelopeSchema.safeParse(safeJsonParse(rawText));
    await meter(organizationId, {
        id: parsed.success ? parsed.data.id : undefined,
        cost: parsed.success ? effectiveUsageCost(parsed.data.usage) : undefined,
    });
    return new Response(rawText, { status: upstream.status, headers: { "Content-Type": "application/json" } });
});

/**
 * Read an SSE stream to completion, scanning for the trailing usage chunk, then
 * meter the captured cost. Detached from the client response (see the tee at the
 * call site) so metering runs to completion regardless of client cancellation.
 */
async function drainStreamForMetering(stream: ReadableStream<Uint8Array>, organizationId: string): Promise<void> {
    const decoder = new TextDecoder();
    const captured: CapturedUsage = {};
    let buffer = "";
    const reader = stream.getReader();

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) captureFromSseLine(line, captured);
        }
        captureFromSseLine(buffer, captured);
        await meter(organizationId, captured);
    } catch (err) {
        logger.error("Failed while draining stream for LLM proxy metering", { organizationId, err });
    } finally {
        reader.releaseLock();
    }
}

function captureFromSseLine(line: string, captured: CapturedUsage): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice("data:".length).trim();
    if (data.length === 0 || data === "[DONE]") return;
    const parsed = UsageEnvelopeSchema.safeParse(safeJsonParse(data));
    if (!parsed.success) return;
    if (parsed.data.id != null) captured.id = parsed.data.id;
    const cost = effectiveUsageCost(parsed.data.usage);
    if (cost != null) captured.cost = cost;
}

async function meter(organizationId: string, captured: CapturedUsage): Promise<void> {
    if (captured.cost == null || !(captured.cost > 0)) {
        logger.warn("No usage cost captured for LLM proxy request - skipping deduction", { organizationId });
        return;
    }
    // Deduction keys on the OpenRouter generation id for idempotency. Without it
    // we'd have to mint a synthetic id, which a re-delivery could double-charge,
    // so skip (log) rather than risk an unbounded charge.
    if (captured.id == null) {
        logger.warn("No OpenRouter generation id captured for LLM proxy request - skipping deduction", {
            organizationId,
        });
        return;
    }
    try {
        await billingService.deductCreditsForLlmProxy(organizationId, captured.cost, captured.id);
    } catch (err) {
        logger.error("Failed to deduct LLM proxy credits", { organizationId, requestId: captured.id, err });
    }
}

function safeJsonParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch (err) {
        logger.debug("Failed to parse JSON from OpenRouter response", { err });
        return undefined;
    }
}
