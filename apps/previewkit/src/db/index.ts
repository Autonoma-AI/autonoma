import { db } from "@autonoma/db";
import type { AppConfig } from "../config/schema";
import { logger as rootLogger } from "../logger";

export type PreviewkitStatus = "pending" | "building" | "deploying" | "ready" | "failed" | "torn_down";

export interface EnvironmentCreatedInput {
    repoFullName: string;
    prNumber: number;
    headSha: string;
    headRef: string;
    namespace: string;
    organizationId: string;
    commentId?: string;
}

export interface PhaseChangedInput {
    namespace: string;
    status: PreviewkitStatus;
    phase: string;
    error?: string;
}

export interface BuildFinishedInput {
    namespace: string;
    headSha: string;
    status: PreviewkitStatus;
    durationMs: number;
    appBuilds: Record<string, { imageTag: string; durationMs: number }>;
    error?: string;
}

export interface EnvironmentReadyInput {
    namespace: string;
    urls: Record<string, string>;
    apps: Array<{ appName: string; imageTag: string; port: number }>;
}

export async function recordEnvironmentCreated(input: EnvironmentCreatedInput): Promise<void> {
    const logger = rootLogger.child({ name: "recordEnvironmentCreated" });
    const { repoFullName, prNumber, headSha, headRef, namespace, organizationId, commentId } = input;
    logger.info("Recording environment created", { namespace, repoFullName, prNumber, organizationId });

    await db.previewkitEnvironment.upsert({
        where: { namespace },
        create: {
            namespace,
            repoFullName,
            prNumber,
            headSha,
            headRef,
            commentId,
            status: "pending",
            phase: "initializing",
            organizationId,
        },
        update: {
            headSha,
            headRef,
            commentId,
            status: "pending",
            phase: "initializing",
            error: null,
            tornDownAt: null,
        },
    });
}

export async function recordPhaseChanged(input: PhaseChangedInput): Promise<void> {
    const logger = rootLogger.child({ name: "recordPhaseChanged" });
    const { namespace, status, phase, error } = input;
    logger.info("Recording phase change", { namespace, status, phase });

    const existing = await db.previewkitEnvironment.findUnique({
        where: { namespace },
        select: { id: true },
    });
    if (existing == null) {
        logger.warn("Skipping phase change: no environment row found", { namespace, status, phase });
        return;
    }

    await db.previewkitEnvironment.update({
        where: { namespace },
        data: {
            status,
            phase,
            error: error ?? null,
            deployedAt: status === "ready" ? new Date() : undefined,
        },
    });
}

export async function recordBuildFinished(input: BuildFinishedInput): Promise<void> {
    const logger = rootLogger.child({ name: "recordBuildFinished" });
    const { namespace, headSha, status, durationMs, appBuilds, error } = input;
    logger.info("Recording build finished", { namespace, headSha, status, durationMs });

    const env = await db.previewkitEnvironment.findUnique({
        where: { namespace },
        select: { id: true },
    });
    if (env == null) {
        logger.warn("Build finished but no environment row found", { namespace });
        return;
    }

    await db.previewkitBuild.create({
        data: {
            environmentId: env.id,
            headSha,
            status,
            durationMs,
            finishedAt: new Date(),
            appBuilds,
            error: error ?? null,
        },
    });
}

export async function recordEnvironmentReady(input: EnvironmentReadyInput): Promise<void> {
    const logger = rootLogger.child({ name: "recordEnvironmentReady" });
    const { namespace, urls, apps } = input;
    logger.info("Recording environment ready", { namespace, appCount: apps.length });

    const env = await db.previewkitEnvironment.findUnique({
        where: { namespace },
        select: { id: true },
    });
    if (env == null) {
        logger.warn("Environment ready but no environment row found", { namespace });
        return;
    }

    await db.$transaction(async (tx) => {
        await tx.previewkitEnvironment.update({
            where: { namespace },
            data: {
                status: "ready",
                phase: "ready",
                error: null,
                urls,
                deployedAt: new Date(),
            },
        });

        for (const app of apps) {
            await tx.previewkitAppInstance.upsert({
                where: { environmentId_appName: { environmentId: env.id, appName: app.appName } },
                create: {
                    environmentId: env.id,
                    appName: app.appName,
                    imageTag: app.imageTag,
                    url: urls[app.appName],
                    port: app.port,
                    ready: false,
                },
                update: {
                    imageTag: app.imageTag,
                    url: urls[app.appName],
                    port: app.port,
                    ready: false,
                },
            });
        }
    });
}

export async function recordEnvironmentTornDown(namespace: string): Promise<void> {
    const logger = rootLogger.child({ name: "recordEnvironmentTornDown" });
    logger.info("Recording environment torn down", { namespace });

    await db.previewkitEnvironment.update({
        where: { namespace },
        data: {
            status: "torn_down",
            phase: "torn_down",
            tornDownAt: new Date(),
        },
    });
}

export function toAppInstances(apps: AppConfig[], imageTags: Record<string, string>): EnvironmentReadyInput["apps"] {
    return apps.map((app) => ({
        appName: app.name,
        imageTag: imageTags[app.name] ?? "",
        port: app.port,
    }));
}
