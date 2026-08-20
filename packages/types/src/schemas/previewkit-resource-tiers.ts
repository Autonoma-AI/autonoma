/**
 * The sizes a preview container may ask for.
 *
 * Resources used to be free strings, so "6Gi because why not" was expressible and
 * nothing pushed back. A closed set means a size is a decision someone made from a
 * menu rather than a number they typed, and it gives the platform something to
 * reason about - a tier can be priced, capped per plan, or resized fleet-wide,
 * which an arbitrary string never could.
 *
 * Apps and services have separate ladders because they are separate workloads.
 * Measured over a week: an app's peak memory has a median of 117Mi and a 90th
 * percentile of 703Mi, while services run from a 54Mi redis to a 1.7Gi postgres.
 * One ladder would have been wrong at both ends.
 */

/** CPU is a request with no limit; memory is both. See `ContainerResources`. */
export interface ResourceTierSize {
    cpu: string;
    memory: string;
}

/**
 * Ordered smallest to largest - the order IS the ladder, and
 * {@link snapToResourceTier} walks it in this sequence.
 */
export const APP_RESOURCE_TIERS = {
    small: { cpu: "150m", memory: "256Mi" },
    standard: { cpu: "250m", memory: "512Mi" },
    /**
     * What almost every app was already running at, so tiers moved nothing. It sits
     * between standard and large on memory alone: measured app CPU has never passed
     * 149m, so 500m is a deliberate step up rather than the next rung.
     */
    medium: { cpu: "250m", memory: "1Gi" },
    large: { cpu: "500m", memory: "1Gi" },
    /** One customer app genuinely runs here, peaking near 2Gi across every deploy. */
    xlarge: { cpu: "500m", memory: "2Gi" },
} as const satisfies Record<string, ResourceTierSize>;

export const SERVICE_RESOURCE_TIERS = {
    small: { cpu: "100m", memory: "256Mi" },
    /** What every service runs at today, so nothing moved when tiers arrived. */
    standard: { cpu: "100m", memory: "1Gi" },
    large: { cpu: "500m", memory: "2Gi" },
} as const satisfies Record<string, ResourceTierSize>;

export type AppResourceTier = keyof typeof APP_RESOURCE_TIERS;
export type ServiceResourceTier = keyof typeof SERVICE_RESOURCE_TIERS;

/**
 * The ladder, in order. Written out rather than derived from the record: key order
 * is an implementation detail of the object literal, and {@link snapToResourceTier}
 * walking them out of order would quietly hand back the wrong tier. A test asserts
 * this covers every tier, so adding one to the record without placing it here fails
 * rather than being skipped.
 */
export const APP_RESOURCE_TIER_NAMES = [
    "small",
    "standard",
    "medium",
    "large",
    "xlarge",
] as const satisfies readonly AppResourceTier[];

export const SERVICE_RESOURCE_TIER_NAMES = [
    "small",
    "standard",
    "large",
] as const satisfies readonly ServiceResourceTier[];

/** The default a container gets when it names no tier. */
export const DEFAULT_APP_RESOURCE_TIER: AppResourceTier = "medium";
export const DEFAULT_SERVICE_RESOURCE_TIER: ServiceResourceTier = "standard";

export function isAppResourceTier(value: string): value is AppResourceTier {
    return value in APP_RESOURCE_TIERS;
}

export function isServiceResourceTier(value: string): value is ServiceResourceTier {
    return value in SERVICE_RESOURCE_TIERS;
}

/**
 * A stored tier name, or the default when it is not one this build knows.
 *
 * A name from a newer build is a config from the future; falling back beats
 * refusing, because the deploy path re-reads stored config and a refusal there
 * takes down a preview that is already running.
 */
export function appResourceTierOrDefault(value: string): AppResourceTier {
    return isAppResourceTier(value) ? value : DEFAULT_APP_RESOURCE_TIER;
}

export function serviceResourceTierOrDefault(value: string): ServiceResourceTier {
    return isServiceResourceTier(value) ? value : DEFAULT_SERVICE_RESOURCE_TIER;
}

const CPU_PATTERN = /^(\d+(?:\.\d+)?)(m?)$/;
const MEMORY_PATTERN = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/;

const MEMORY_MULTIPLIERS: Readonly<Record<string, number>> = {
    "": 1,
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
};

/** Millicores, or undefined when the string is not a CPU quantity. */
export function parseCpu(value: string): number | undefined {
    const match = CPU_PATTERN.exec(value.trim());
    if (match?.[1] == null) return undefined;
    const amount = Number(match[1]);
    return match[2] === "m" ? amount : amount * 1000;
}

/** Bytes, or undefined when the string is not a memory quantity. */
export function parseMemory(value: string): number | undefined {
    const match = MEMORY_PATTERN.exec(value.trim());
    if (match?.[1] == null) return undefined;
    const multiplier = MEMORY_MULTIPLIERS[match[2] ?? ""];
    return multiplier == null ? undefined : Number(match[1]) * multiplier;
}

/**
 * The smallest tier that covers a raw `cpu` / `memory` pair, for reading a config
 * written before tiers existed.
 *
 * Snaps UP, on both dimensions at once, which is why a container asking for a lot
 * of CPU and little memory can land higher than its memory alone suggests: a tier
 * has to cover everything the container asked for or it is not a fit. Snapping
 * down would silently shrink a running container into OOM-killing, which is the
 * one outcome reading an old config must not produce.
 *
 * A value larger than every tier gets the largest one - the alternative is
 * refusing to parse a config that is already deployed and running.
 */
export function snapToResourceTier<TTier extends string>(
    tiers: Record<TTier, ResourceTierSize>,
    order: readonly TTier[],
    requested: { cpu?: string | undefined; memory?: string | undefined },
): TTier {
    const wantedCpu = requested.cpu == null ? 0 : (parseCpu(requested.cpu) ?? 0);
    const wantedMemory = requested.memory == null ? 0 : (parseMemory(requested.memory) ?? 0);

    for (const name of order) {
        const tier = tiers[name];
        const cpu = parseCpu(tier.cpu) ?? 0;
        const memory = parseMemory(tier.memory) ?? 0;
        if (cpu >= wantedCpu && memory >= wantedMemory) return name;
    }

    const largest = order[order.length - 1];
    if (largest == null) throw new Error("A resource ladder cannot be empty.");
    return largest;
}
