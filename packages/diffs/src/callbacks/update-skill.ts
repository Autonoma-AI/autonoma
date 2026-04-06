import type { PrismaClient } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { type TestSuiteUpdater, UpdateSkill } from "@autonoma/test-updates";
import type { TestDirectory } from "../test-directory";

interface UpdateSkillParams {
    skillId: string;
    newContent: string;
}

interface UpdateSkillDeps {
    db: PrismaClient;
    updater: TestSuiteUpdater;
    applicationId: string;
    testDirectory: TestDirectory;
}

export async function updateSkill(
    { skillId, newContent }: UpdateSkillParams,
    { db, updater, applicationId, testDirectory }: UpdateSkillDeps,
): Promise<void> {
    logger.info("Updating skill", { skillId });

    const skill = await db.skill.findFirst({
        where: { id: skillId, applicationId },
        select: { id: true, slug: true, name: true, description: true },
    });

    if (skill == null) {
        logger.warn("Skill not found for update", { skillId });
        return;
    }

    await updater.apply(new UpdateSkill({ skillId: skill.id, plan: newContent }));
    await testDirectory.writeSkill({ ...skill, content: newContent });
    logger.info("Skill updated and written to disk", { skillId });
}
