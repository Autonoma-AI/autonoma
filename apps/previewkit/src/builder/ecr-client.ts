import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    CreateRepositoryCommand,
    ECRClient,
    GetAuthorizationTokenCommand,
    ImageTagMutability,
    RepositoryAlreadyExistsException,
} from "@aws-sdk/client-ecr";
import { logger } from "../logger";

export interface EcrAuth {
    hostname: string;
    /** base64("AWS:<password>") — Docker auth format expected by buildctl */
    authToken: string;
}

export class EcrRegistryClient {
    private readonly logger = logger.child({ name: this.constructor.name });

    constructor() {}

    async ensureRepo(imageTag: string): Promise<void> {
        const match = imageTag.match(/^(\d+)\.dkr\.ecr\.([^.]+)\.amazonaws\.com\/([^:]+):/);
        if (match == null) return;

        const [, , region, repositoryName] = match as [string, string, string, string];

        const ecr = new ECRClient({ region });

        try {
            await ecr.send(
                new CreateRepositoryCommand({
                    repositoryName,
                    imageTagMutability: ImageTagMutability.MUTABLE,
                    imageScanningConfiguration: { scanOnPush: false },
                }),
            );
            this.logger.info("Created ECR repository", { repositoryName, region });
        } catch (err) {
            if (err instanceof RepositoryAlreadyExistsException) return;
            throw err;
        }
    }

    async getAuth(imageTag: string): Promise<EcrAuth | undefined> {
        const match = imageTag.match(/^(\d+\.dkr\.ecr\.([^.]+)\.amazonaws\.com)\//);
        if (match == null) return undefined;

        const [, hostname, region] = match as [string, string, string];

        const ecr = new ECRClient({ region });
        const { authorizationData } = await ecr.send(new GetAuthorizationTokenCommand({}));
        const authToken = authorizationData?.[0]?.authorizationToken;
        if (authToken == null) {
            this.logger.warn("No ECR authorization token returned", { hostname });
            return undefined;
        }

        this.logger.info("Retrieved ECR auth token", { hostname });
        return { hostname, authToken };
    }

    async writeDockerConfig(auth: EcrAuth): Promise<string> {
        const dir = join(tmpdir(), `previewkit-docker-${Date.now()}`);
        await mkdir(dir, { recursive: true });
        const config = { auths: { [auth.hostname]: { auth: auth.authToken } } };
        await writeFile(join(dir, "config.json"), JSON.stringify(config));
        return dir;
    }
}
