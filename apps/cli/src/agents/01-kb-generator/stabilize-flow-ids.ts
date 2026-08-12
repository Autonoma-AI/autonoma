import { debugLog } from "../../core/debug";
import { slugify } from "../../core/output";
import type { CoreFlow, CoreFlowsSpec } from "./flow-spec";

/**
 * Id given to a flow whose routes carry no static segment to name it after - a
 * flow that owns only the root or only parameterised routes. Rare, and a name a
 * human can still read.
 */
const ROOT_FLOW_ID = "home";

/**
 * Replace each flow's model-invented id with one derived from the routes it owns.
 *
 * The model reinvents the id every run - the same load-bearing flow came back as
 * `test-creation`, `test-authoring`, `test-creation-authoring` across runs of one
 * app - which leaves nothing stable to key cross-run scoring on and drowns the git
 * signal in relabelling noise. The routes it owns do not churn like that: they are
 * read off the router, which is in the codebase. Anchoring the id to a flow's
 * shallowest owned route makes it stable while a name or a peripheral entry point
 * moves, and it composes with the closed-set enforcement downstream, which keys on
 * exactly this id.
 *
 * Only the id changes. The human-readable `feature` name, the tier and every other
 * field are the model's, untouched.
 */
export function stabilizeFlowIds(spec: CoreFlowsSpec): CoreFlowsSpec {
    const ids = assignUniqueIds(spec.flows);
    const flows = spec.flows.map((flow, i) => withId(flow, ids[i] ?? ROOT_FLOW_ID));
    return { pitch: spec.pitch, flows };
}

/**
 * A stable slug for each flow, positionally aligned with `flows`, guaranteed
 * unique. The base slug comes from the flow's primary route. A collision - two
 * flows resolving to the same base, which the "claim the shallowest route once"
 * rule should prevent but a model can still violate - is broken with a numeric
 * suffix; when the bases tie, the earlier-listed flow keeps the bare slug, since
 * two flows claiming one route give nothing else to tell them apart by.
 */
function assignUniqueIds(flows: readonly CoreFlow[]): string[] {
    const bases = flows.map((flow) => slugFromRoute(primaryRoute(flow.entryPoints)));

    const order = bases
        .map((base, index) => ({ base, index }))
        .sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : a.index - b.index));

    const assigned = new Array<string>(flows.length);
    const seen = new Map<string, number>();
    for (const { base, index } of order) {
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        if (count === 0) {
            assigned[index] = base;
            continue;
        }
        const disambiguated = `${base}-${count + 1}`;
        debugLog("Two flows derived the same id; disambiguating", { base, disambiguated });
        assigned[index] = disambiguated;
    }
    return assigned;
}

/**
 * The route that names a flow: the shallowest one it owns, since that is the flow's
 * home and the deeper routes are pages within it. Ties are broken lexicographically
 * so a peripheral route flapping in and out cannot rename the flow as long as the
 * home route stays put.
 */
function primaryRoute(entryPoints: readonly string[]): string | undefined {
    let best: string | undefined;
    let bestDepth = Number.POSITIVE_INFINITY;
    for (const route of entryPoints) {
        const depth = routeDepth(route);
        const isShallower = depth < bestDepth;
        const isEarlierAtSameDepth = depth === bestDepth && best != null && route < best;
        if (isShallower || isEarlierAtSameDepth) {
            best = route;
            bestDepth = depth;
        }
    }
    return best;
}

function routeDepth(route: string): number {
    return route.split("/").filter((segment) => segment.length > 0).length;
}

/**
 * Slug a route by its static segments, dropping parameters (`[id]`, `:id`, `*`)
 * because they carry no stable name and two flows should never be told apart by
 * one. A route with nothing but parameters, or the bare root, has no name to give.
 */
function slugFromRoute(route: string | undefined): string {
    if (route == null) return ROOT_FLOW_ID;
    const staticSegments = route.split("/").filter((segment) => segment.length > 0 && !isParameter(segment));
    const slug = slugify(staticSegments.join("-"));
    return slug.length > 0 ? slug : ROOT_FLOW_ID;
}

function isParameter(segment: string): boolean {
    return segment.startsWith("[") || segment.startsWith(":") || segment === "*";
}

function withId(flow: CoreFlow, id: string): CoreFlow {
    return {
        id,
        feature: flow.feature,
        description: flow.description,
        mission: flow.mission,
        tier: flow.tier,
        tierReason: flow.tierReason,
        invariants: flow.invariants,
        riskDrivers: flow.riskDrivers,
        entryPoints: flow.entryPoints,
    };
}
