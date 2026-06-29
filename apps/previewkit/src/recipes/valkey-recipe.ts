import type { ServiceConfig } from "../config/schema";
import { type DockerImageOptions, DockerImageRecipe, dockerImageOptionsSchema } from "./docker-image-recipe";
import { BaseRecipe, type RecipeConnectionInfo, type RecipeResources } from "./recipe";

const DEFAULT_VERSION = "8-alpine";
const PORT = 6379;

export class ValkeyRecipe extends BaseRecipe<DockerImageOptions> {
    readonly name = "valkey";
    readonly schema = dockerImageOptionsSchema;
    private readonly base = new DockerImageRecipe();

    override parseOptions(config: ServiceConfig): DockerImageOptions {
        const version = config.version ?? DEFAULT_VERSION;
        return {
            image: `valkey/valkey:${version}`,
            port_definition: { port: PORT },
            additional_ports: [],
            readiness: {
                exec: { command: ["valkey-cli", "ping"] },
                initial_delay_seconds: 3,
                period_seconds: 5,
            },
        };
    }

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        // Valkey is wire-compatible with Redis, so clients use the redis:// scheme.
        return { host: config.name, port: PORT, url: `redis://${config.name}:${PORT}` };
    }

    typedGenerate(config: ServiceConfig<DockerImageOptions>, namespace: string): RecipeResources {
        return this.base.typedGenerate(config, namespace);
    }
}
