/** The boundary an AmpPrometheusClient signs and sends a PromQL instant query through. */
export interface AmpRequestSender {
    send(query: string, time: Date): Promise<unknown>;
}
