import type { ServerType } from "@hono/node-server";
import { serve as defaultServe } from "@hono/node-server";

interface LoggerLike {
    info: (message: string) => void;
}

interface StartApiServerParams {
    app: Pick<NonNullable<Parameters<typeof defaultServe>[0]>, "fetch">;
    port: number;
    logger: LoggerLike;
    serve?: typeof defaultServe;
}

export function startApiServer({ app, port, logger, serve = defaultServe }: StartApiServerParams): ServerType {
    const server = serve({ fetch: app.fetch, port });
    logger.info(`Server running on port ${port}`);
    return server;
}
