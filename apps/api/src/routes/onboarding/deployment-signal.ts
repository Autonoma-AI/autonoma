import { createHmac, timingSafeEqual } from "node:crypto";
import { BadRequestError } from "@autonoma/errors";
import { logger } from "@autonoma/logger";
import { z } from "zod";

export interface DeploymentSignalInput {
    bodyText: string;
    signature: string;
}

const deploymentSignalBodySchema = z.object({
    applicationId: z.string().min(1),
    previewUrl: z.string().url(),
    branch: z
        .union([z.string().regex(/^[A-Za-z0-9._/-]{1,255}$/), z.literal("").transform(() => undefined)])
        .optional(),
    sha: z.union([z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), z.literal("").transform(() => undefined)]).optional(),
    provider: z.union([z.string().min(1), z.literal("").transform(() => undefined)]).optional(),
    prNumber: z.coerce.number().int().positive().optional(),
});

const deploymentSignalBodyTextSchema = z
    .string()
    .transform((value, context) => {
        try {
            const parsed: unknown = JSON.parse(value);
            return parsed;
        } catch (err) {
            logger.child({ name: "parseDeploymentSignalBody" }).debug("Failed to parse deployment signal JSON body", {
                err,
            });
            context.addIssue({ code: "custom", message: "Invalid JSON body" });
            return z.NEVER;
        }
    })
    .pipe(deploymentSignalBodySchema);

export type DeploymentSignalBody = z.infer<typeof deploymentSignalBodySchema>;

export function parseDeploymentSignalBody(bodyText: string): DeploymentSignalBody {
    const result = deploymentSignalBodyTextSchema.safeParse(bodyText);
    if (!result.success) throw new BadRequestError(`Invalid deployment signal body: ${z.prettifyError(result.error)}`);
    return result.data;
}

export function verifySignature(bodyText: string, signature: string, signingSecret: string): boolean {
    if (signature.length === 0) return false;
    const expected = createHmac("sha256", signingSecret).update(bodyText).digest("hex");
    if (signature.length !== expected.length) return false;
    const providedBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (providedBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(providedBuffer, expectedBuffer);
}

/** True for a 40-char hex commit SHA (some providers report the SHA in the branch field). */
export function isCommitSha(value: string): boolean {
    return /^[a-f0-9]{40}$/i.test(value);
}
