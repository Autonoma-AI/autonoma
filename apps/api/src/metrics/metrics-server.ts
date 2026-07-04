import { createServer, type Server } from "node:http";
import { type Logger, logger } from "@autonoma/logger";
import type { Registry } from "prom-client";

/**
 * Serves the prom-client registry over plain HTTP on a dedicated port, kept
 * off the public API port so the ingress never exposes /metrics. Prometheus
 * discovers it through the `prometheus.io/*` pod annotations on the API
 * Deployment (deployment/apps/api.yaml) and scrapes the pod IP directly - no
 * Service or Ingress involved.
 */
export class MetricsServer {
    private readonly logger: Logger;
    private server?: Server;

    constructor(
        private readonly registry: Registry,
        private readonly port: number,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    start(): void {
        const server = createServer((req, res) => {
            const path = req.url?.split("?")[0];
            if (req.method !== "GET" || path !== "/metrics") {
                res.writeHead(404).end();
                return;
            }
            this.registry
                .metrics()
                .then((body) => {
                    res.writeHead(200, { "content-type": this.registry.contentType }).end(body);
                })
                .catch((err: unknown) => {
                    this.logger.error("Failed to render metrics", { err });
                    res.writeHead(500).end();
                });
        });
        // A bind failure (port taken - e.g. two dev APIs on one machine) is
        // logged instead of crashing the API: metrics are an observability
        // side-channel and must never take the serving process down with them.
        server.on("error", (err) => {
            this.logger.error("Metrics server failed", { port: this.port, err });
        });
        server.listen(this.port, () => {
            this.logger.info("Metrics server listening", { port: this.port });
        });
        this.server = server;
    }

    async stop(): Promise<void> {
        const server = this.server;
        if (server == null) return;
        this.server = undefined;
        this.logger.info("Stopping metrics server");
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    }
}
