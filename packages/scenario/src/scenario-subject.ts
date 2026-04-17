import type { PrismaClient } from "@autonoma/db";

export interface ScenarioApplicationData {
    applicationId: string;
    deploymentId: string;
    organizationId: string;
    webhookUrl: string;
    signingSecretEnc: string;
    webhookHeaders?: Record<string, string>;
}

export interface ScenarioSubject {
    getApplicationData(): Promise<ScenarioApplicationData>;
    linkInstance(instanceId: string): Promise<void>;
}

export class GenerationSubject implements ScenarioSubject {
    constructor(
        private readonly db: PrismaClient,
        private readonly generationId: string,
    ) {}

    async getApplicationData(): Promise<ScenarioApplicationData> {
        const generation = await this.db.testGeneration.findUniqueOrThrow({
            where: { id: this.generationId },
            select: {
                snapshot: {
                    select: {
                        branch: {
                            select: {
                                deployment: {
                                    select: { id: true, webhookUrl: true, webhookHeaders: true },
                                },
                            },
                        },
                    },
                },
                testPlan: {
                    select: {
                        testCase: {
                            select: {
                                application: {
                                    select: {
                                        id: true,
                                        organizationId: true,
                                        signingSecretEnc: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        const { application } = generation.testPlan.testCase;
        const deployment = generation.snapshot.branch.deployment;
        if (deployment?.webhookUrl == null || application.signingSecretEnc == null) {
            throw new Error(`Application ${application.id} does not have a webhook configured`);
        }

        return {
            applicationId: application.id,
            deploymentId: deployment.id,
            organizationId: application.organizationId,
            webhookUrl: deployment.webhookUrl,
            signingSecretEnc: application.signingSecretEnc,
            webhookHeaders: (deployment.webhookHeaders as Record<string, string> | undefined) ?? undefined,
        };
    }

    async linkInstance(instanceId: string): Promise<void> {
        await this.db.testGeneration.update({
            where: { id: this.generationId },
            data: { scenarioInstanceId: instanceId },
        });
    }
}

export class RunSubject implements ScenarioSubject {
    constructor(
        private readonly db: PrismaClient,
        private readonly runId: string,
    ) {}

    async getApplicationData(): Promise<ScenarioApplicationData> {
        const run = await this.db.run.findUniqueOrThrow({
            where: { id: this.runId },
            select: {
                assignment: {
                    select: {
                        snapshot: {
                            select: {
                                branch: {
                                    select: {
                                        deployment: {
                                            select: { id: true, webhookUrl: true, webhookHeaders: true },
                                        },
                                    },
                                },
                            },
                        },
                        testCase: {
                            select: {
                                application: {
                                    select: {
                                        id: true,
                                        organizationId: true,
                                        signingSecretEnc: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        const { application } = run.assignment.testCase;
        const deployment = run.assignment.snapshot.branch.deployment;
        if (deployment?.webhookUrl == null || application.signingSecretEnc == null) {
            throw new Error(`Application ${application.id} does not have a webhook configured`);
        }

        return {
            applicationId: application.id,
            deploymentId: deployment.id,
            organizationId: application.organizationId,
            webhookUrl: deployment.webhookUrl,
            signingSecretEnc: application.signingSecretEnc,
            webhookHeaders: (deployment.webhookHeaders as Record<string, string> | undefined) ?? undefined,
        };
    }

    async linkInstance(instanceId: string): Promise<void> {
        await this.db.run.update({
            where: { id: this.runId },
            data: { scenarioInstanceId: instanceId },
        });
    }
}
