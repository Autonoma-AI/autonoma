import { createGunzip } from "node:zlib";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type * as k8s from "@kubernetes/client-node";
import type { Logger } from "../logger";
import { logger as rootLogger } from "../logger";
import { execInDeploymentPod } from "./pod-exec";

export interface PostgresRestoreConfig {
    serviceName: string;
    bucket: string;
    key: string;
    region?: string;
    dbUser: string;
    dbName: string;
}

/**
 * Downloads a pg_dump custom-format backup from S3, decompresses it, and
 * restores it into the preview postgres service via kubectl exec + pg_restore
 * piped over stdin.
 *
 * The restore runs AFTER the postgres pod is ready and BEFORE apps are deployed,
 * so apps boot against pre-seeded data.
 */
export class PostgresRestorer {
    private readonly logger: Logger;

    constructor(
        private readonly kc: k8s.KubeConfig,
        private readonly namespace: string,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name, namespace });
    }

    async restore(config: PostgresRestoreConfig): Promise<void> {
        this.logger.info("Restoring postgres from S3 backup", {
            serviceName: config.serviceName,
            bucket: config.bucket,
            key: config.key,
        });

        const dump = await this.downloadAndDecompress(config);

        this.logger.info("Dump downloaded and decompressed, running pg_restore", {
            serviceName: config.serviceName,
            bytes: dump.length,
        });

        const command =
            `pg_restore -U ${config.dbUser} -d ${config.dbName} ` + `--no-owner --no-acl --clean --if-exists || true`;

        await execInDeploymentPod(this.kc, this.namespace, config.serviceName, command, dump);

        this.logger.info("Postgres restore complete", { serviceName: config.serviceName });
    }

    private async downloadAndDecompress(config: PostgresRestoreConfig): Promise<Buffer> {
        const client = new S3Client({ region: config.region ?? "us-east-1" });

        this.logger.info("Downloading backup from S3", { bucket: config.bucket, key: config.key });

        const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: config.key }));

        if (response.Body == null) {
            throw new Error(`S3 object ${config.bucket}/${config.key} has no body`);
        }

        const chunks: Buffer[] = [];

        await new Promise<void>((resolve, reject) => {
            const gunzip = createGunzip();
            gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
            gunzip.on("end", resolve);
            gunzip.on("error", reject);

            const body = response.Body as NodeJS.ReadableStream;
            body.on("error", reject);
            body.pipe(gunzip);
        });

        return Buffer.concat(chunks);
    }
}
