import { runWithSentry } from "@autonoma/logger";
import { env } from "./env";
import { runGenerationAssignment } from "./run";

const generationIds = process.argv.slice(2);
if (generationIds.length === 0) {
    console.error("Usage: generation-assigner <generationId1> <generationId2> ...");
    process.exit(1);
}

const autoActivate = env.AUTO_ACTIVATE === "true";

await runWithSentry({ name: "generation-assigner", tags: { generationCount: String(generationIds.length) } }, () =>
    runGenerationAssignment(generationIds, autoActivate),
);
