import { Badge } from "@autonoma/blacklight";
import { useSuspenseQuery } from "@tanstack/react-query";
import { formatRelativeTime } from "lib/format";
import { trpc } from "lib/trpc";

type InstanceStatus = "REQUESTED" | "UP_SUCCESS" | "UP_FAILED" | "RUNNING_TESTS" | "DOWN_SUCCESS" | "DOWN_FAILED";

function instanceStatusBadgeVariant(status: InstanceStatus): "outline" | "success" | "critical" | "status-running" {
  switch (status) {
    case "REQUESTED":
      return "outline";
    case "UP_SUCCESS":
      return "success";
    case "UP_FAILED":
      return "critical";
    case "RUNNING_TESTS":
      return "status-running";
    case "DOWN_SUCCESS":
      return "success";
    case "DOWN_FAILED":
      return "critical";
  }
}

/**
 * Every provisioning of one scenario, newest first.
 *
 * Each run carries the fingerprint of the recipe it actually provisioned. That matters because the
 * recipe is editable - by a person here, or by an agent over MCP - so a run listed under a scenario
 * has not necessarily exercised the recipe shown in the editor beside it. `recipeSuperseded` is
 * computed server-side, where the scenario's current fingerprint is known.
 */
export function ScenarioInstancesList({ scenarioId }: { scenarioId: string }) {
  const { data: instances } = useSuspenseQuery(trpc.scenarios.listInstances.queryOptions({ scenarioId }));

  if (instances.length === 0) {
    return <p className="font-mono text-2xs text-text-secondary">No instances yet.</p>;
  }

  return (
    <div className="flex flex-col divide-y divide-border-dim border border-border-dim">
      {instances.map((instance) => (
        <div key={instance.id} className="flex flex-col gap-2 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-2xs text-text-secondary">{instance.id.slice(0, 12)}</span>
            <Badge variant={instanceStatusBadgeVariant(instance.status as InstanceStatus)}>
              {instance.status.replace(/_/g, " ")}
            </Badge>
          </div>
          <div className="flex gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-3xs text-text-secondary">Requested</span>
              <span className="font-mono text-2xs text-text-secondary">
                {formatRelativeTime(new Date(instance.requestedAt))}
              </span>
            </div>
            {instance.upAt != null && (
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-3xs text-text-secondary">Up</span>
                <span className="font-mono text-2xs text-text-secondary">
                  {formatRelativeTime(new Date(instance.upAt))}
                </span>
              </div>
            )}
            {instance.completedAt != null && (
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-3xs text-text-secondary">Completed</span>
                <span className="font-mono text-2xs text-text-secondary">
                  {formatRelativeTime(new Date(instance.completedAt))}
                </span>
              </div>
            )}
            {instance.recipeFingerprint != null && (
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-3xs text-text-secondary">Recipe</span>
                <span className="flex items-center gap-1.5 font-mono text-2xs text-text-secondary">
                  {instance.recipeFingerprint.slice(0, 8)}
                  {instance.recipeSuperseded && <Badge variant="warn">superseded</Badge>}
                </span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
