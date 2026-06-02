import type {
    AutonomaCommentCta,
    AutonomaCommentPayload,
    AutonomaCommentState,
    AutonomaCommentStats,
    PayloadBuilderInput,
} from "./types";

export function payloadBuilder(input: PayloadBuilderInput): AutonomaCommentPayload {
    const services = input.services ?? [];
    const bugs = input.bugs ?? [];

    return {
        state: input.state,
        prNumber: input.prNumber,
        headline: input.message ?? defaultHeadline(input.state, bugs.length, input.tests?.failed),
        stats: buildStats(input.tests),
        commitRef: input.commitSha?.slice(0, 7),
        duration: input.duration,
        assetBaseUrl: input.assetBaseUrl ?? undefined,
        ctas: buildCtas(input),
        services,
        addons: input.addons ?? [],
        bugs,
        warnings: input.warnings ?? [],
        details: input.details ?? buildServiceErrorDetails(services),
    };
}

function defaultHeadline(state: AutonomaCommentState, bugCount: number, failedCount: number | undefined): string {
    switch (state) {
        case "running":
            return "Autonoma received this commit and is preparing the preview and test sweep.";
        case "healthy":
            return "Autonoma found no blocking bugs in this PR sweep.";
        case "critical": {
            const count = bugCount > 0 ? bugCount : (failedCount ?? 1);
            return `Autonoma found ${count} ${count === 1 ? "bug" : "bugs"} in this PR.`;
        }
        case "unknown":
            return "Autonoma could not determine this PR sweep status.";
    }
}

function buildStats(tests: PayloadBuilderInput["tests"]): AutonomaCommentStats | undefined {
    if (tests == null) return undefined;
    const { selected, passed, failed, skipped } = tests;
    if (selected == null && passed == null && failed == null && skipped == null) return undefined;
    return { selected, passed, failed, skipped };
}

function buildCtas(input: PayloadBuilderInput): AutonomaCommentCta[] {
    const ctas: AutonomaCommentCta[] = [];
    if (input.summaryUrl != null && input.summaryUrl !== "")
        ctas.push({ label: "Open in Autonoma", href: input.summaryUrl });
    if (input.previewUrl != null && input.previewUrl !== "")
        ctas.push({ label: "See preview", href: input.previewUrl });
    return ctas;
}

function buildServiceErrorDetails(
    services: NonNullable<PayloadBuilderInput["services"]>,
): Array<{ summary: string; body: string }> {
    return services
        .filter((service) => service.error != null && service.error !== "")
        .map((service) => ({ summary: `${service.name} - error`, body: service.error! }));
}
