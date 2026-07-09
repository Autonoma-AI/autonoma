import type { PrismaClient } from "@autonoma/db";

export interface ScenarioSubject {
    /** Resolve the (applicationId, deploymentId) tuple this entity is associated with. */
    resolveDeployment(): Promise<{ applicationId: string; deploymentId: string }>;
    /** Optionally link the created scenario instance back to the entity. */
    linkInstance?(instanceId: string): Promise<void>;
}

export class GenerationSubject implements ScenarioSubject {
    constructor(
        private readonly db: PrismaClient,
        private readonly generationId: string,
    ) {}

    async resolveDeployment(): Promise<{ applicationId: string; deploymentId: string }> {
        const generation = await this.db.testGeneration.findUniqueOrThrow({
            where: { id: this.generationId },
            select: {
                snapshot: { select: { branch: { select: { deployment: { select: { id: true } } } } } },
                testPlan: { select: { testCase: { select: { applicationId: true } } } },
            },
        });

        const deploymentId = generation.snapshot.branch.deployment?.id;
        if (deploymentId == null) {
            throw new Error(`Generation ${this.generationId} has no deployment`);
        }
        return {
            applicationId: generation.testPlan.testCase.applicationId,
            deploymentId,
        };
    }

    async linkInstance(instanceId: string): Promise<void> {
        await this.db.testGeneration.update({
            where: { id: this.generationId },
            data: { scenarioInstanceId: instanceId },
        });
    }
}
