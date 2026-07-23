import { quoteEnv } from "./quote-env";

/**
 * ENV lines that point npm/pnpm/yarn-classic (via npm's shared `npm_config_*`
 * env convention) and bun at an in-VPC package-manager cache, so installs
 * only reach the public registry once per package, cluster-wide, instead of
 * on every single build. Yarn Berry ignores both variables and needs its own
 * `.yarnrc.yml` override instead, so it is not covered here.
 */
export function npmRegistryEnvLines(npmRegistryMirror: string): string[] {
    const value = quoteEnv(npmRegistryMirror);
    return [`ENV npm_config_registry=${value} \\`, `    BUN_CONFIG_REGISTRY=${value}`];
}
