import type { AppConfig } from "../config/schema";

/**
 * Kahn's algorithm: groups apps into ordered deployment waves so that
 * within each wave all apps can be deployed in parallel, and every app's
 * depends_on entries are fully deployed before the app's own wave starts.
 *
 * Throws if any depends_on entry names an unknown app or if a circular
 * dependency is detected.
 */
export function computeDeployWaves(apps: AppConfig[]): AppConfig[][] {
    if (apps.length === 0) return [];

    const appByName = new Map(apps.map((a) => [a.name, a]));
    const inDegree = new Map(apps.map((a) => [a.name, 0]));
    const dependents = new Map<string, string[]>(apps.map((a) => [a.name, []]));

    for (const app of apps) {
        for (const dep of app.depends_on ?? []) {
            if (!appByName.has(dep)) {
                throw new Error(`App "${app.name}" has unknown depends_on "${dep}"`);
            }
            inDegree.set(app.name, inDegree.get(app.name)! + 1);
            dependents.get(dep)!.push(app.name);
        }
    }

    const waves: AppConfig[][] = [];
    let current = apps.filter((a) => inDegree.get(a.name) === 0);

    while (current.length > 0) {
        waves.push(current);
        const nextNames: string[] = [];
        for (const app of current) {
            for (const dependent of dependents.get(app.name)!) {
                const remaining = inDegree.get(dependent)! - 1;
                inDegree.set(dependent, remaining);
                if (remaining === 0) {
                    nextNames.push(dependent);
                }
            }
        }
        current = nextNames.map((name) => appByName.get(name)!);
    }

    const placed = waves.flat().length;
    if (placed !== apps.length) {
        const cycleApps = apps
            .filter((a) => inDegree.get(a.name)! > 0)
            .map((a) => a.name)
            .join(", ");
        throw new Error(`Circular dependency detected among apps: ${cycleApps}`);
    }

    return waves;
}
