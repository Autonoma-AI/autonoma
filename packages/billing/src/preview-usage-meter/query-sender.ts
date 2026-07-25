/** The boundary a PrometheusClient sends a PromQL instant query through. */
export interface QuerySender {
    send(query: string, time: Date): Promise<unknown>;
}
