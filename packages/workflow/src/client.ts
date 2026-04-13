import { type Logger, logger } from "@autonoma/logger";
import { Client, Connection } from "@temporalio/client";
import { env } from "./env";

let temporalClient: Client | undefined;

export async function getTemporalClient(): Promise<Client> {
    if (temporalClient != null) return temporalClient;

    const log: Logger = logger.child({ name: "TemporalClient" });
    log.info("Connecting to Temporal", { address: env.TEMPORAL_ADDRESS, namespace: env.TEMPORAL_NAMESPACE });

    const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS });

    temporalClient = new Client({
        connection,
        namespace: env.TEMPORAL_NAMESPACE,
    });

    log.info("Temporal client connected");

    return temporalClient;
}

/** Reset the singleton - useful for testing. */
export function resetTemporalClient(): void {
    temporalClient = undefined;
}
