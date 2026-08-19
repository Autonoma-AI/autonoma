import { Badge, Button, Input, Skeleton } from "@autonoma/blacklight";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CoinsIcon } from "@phosphor-icons/react/Coins";
import { formatRelativeTime } from "lib/format";
import {
  useAdminComputePricingReference,
  useAdminEnvironmentComputeUsage,
  useUpdateComputePricing,
} from "lib/query/admin.queries";
import { useEffect, useState } from "react";

/**
 * Admin-only Previewkit compute usage for this environment - build and running compute,
 * priced through the same pricing table billing itself uses. Zero credits means the
 * pricing is currently zeroed out (shadow mode), not that the usage was free. Collapsible
 * (see `AdminAiCostPanel`); `defaultOpen` starts it expanded for the dedicated Usage tab.
 *
 * Also shows the global, AWS-derived pricing reference (kept current by the weekly
 * aws-compute-pricing-drift cronjob) next to a form to set this org's live rate - applying it
 * is always a deliberate admin action here, never something the cronjob does on its own.
 */
export function AdminComputeUsagePanel({
  environmentId,
  defaultOpen = false,
}: {
  environmentId: string;
  defaultOpen?: boolean;
}) {
  const { data, isPending, isError } = useAdminEnvironmentComputeUsage(environmentId, true);

  // Quiet on failure - this is a bonus operational panel, not core preview content.
  if (isError) return null;

  return (
    <details className="group shrink-0 border border-border-dim bg-surface-base" open={defaultOpen ? true : undefined}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3">
        <CaretRightIcon size={12} className="shrink-0 text-text-tertiary transition-transform group-open:rotate-90" />
        <CoinsIcon size={14} className="shrink-0 text-text-secondary" />
        <span className="font-mono text-xs font-semibold uppercase tracking-widest text-text-primary">
          Compute usage
        </span>
        <Badge variant="outline" className="font-mono text-2xs uppercase tracking-wider">
          Admin
        </Badge>
      </summary>
      <div className="border-t border-border-dim">
        {isPending ? (
          <ComputeUsageRowsSkeleton />
        ) : (
          <div className="flex flex-col">
            <ComputeUsageRow
              label="Build"
              vcpuSeconds={data.build.vcpuSeconds}
              gbSeconds={data.build.gbSeconds}
              count={data.build.buildCount}
              countLabel="app builds"
              credits={data.build.credits}
            />
            <ComputeUsageRow
              label="Running"
              vcpuSeconds={data.running.vcpuSeconds}
              gbSeconds={data.running.gbSeconds}
              count={data.running.windowCount}
              countLabel="windows"
              credits={data.running.credits}
            />
            <div className="px-4 py-2 font-mono text-2xs text-text-secondary">
              Priced at {data.creditsPerVcpuHour} credits/vCPU-hr, {data.creditsPerGbMemoryHour} credits/GB-hr
              {data.creditsPerVcpuHour === 0 && data.creditsPerGbMemoryHour === 0 && " (shadow mode - not yet billed)"}
            </div>
            <ComputePricingSettings
              organizationId={data.organizationId}
              organizationName={data.organizationName}
              currentCreditsPerVcpuHour={data.creditsPerVcpuHour}
              currentCreditsPerGbMemoryHour={data.creditsPerGbMemoryHour}
            />
          </div>
        )}
      </div>
    </details>
  );
}

function ComputeUsageRow({
  label,
  vcpuSeconds,
  gbSeconds,
  count,
  countLabel,
  credits,
}: {
  label: string;
  vcpuSeconds: number;
  gbSeconds: number;
  count: number;
  countLabel: string;
  credits: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border-dim px-4 py-2 last:border-b-0">
      <span className="w-16 shrink-0 text-sm font-medium text-text-primary">{label}</span>
      <span className="font-mono text-2xs text-text-secondary">
        {count} {countLabel}
      </span>
      <span className="font-mono text-2xs text-text-secondary">{vcpuSeconds.toFixed(2)} vCPU-s</span>
      <span className="font-mono text-2xs text-text-secondary">{gbSeconds.toFixed(2)} GB-s</span>
      <span className="ml-auto font-mono text-xs text-text-primary">{credits.toFixed(4)} credits</span>
    </div>
  );
}

function ComputeUsageRowsSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-4">
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-full" />
    </div>
  );
}

/**
 * The AWS reference rate (informational, global) plus a form to set one org's live rate.
 *
 * The org comes from the ENVIRONMENT being viewed, never from whichever org the admin is currently
 * acting as: the rates displayed here are read from the environment's owner, so writing them back
 * anywhere else would edit an org the admin is not looking at while the toast confirms success. An
 * admin can genuinely be switched into a different org than the environment's owner (see
 * `admin.switchToOrg` and the cross-org deep-link recovery in `-app-not-found.tsx`), so the read and
 * the write have to name the same org by construction rather than by convention.
 */
function ComputePricingSettings({
  organizationId,
  organizationName,
  currentCreditsPerVcpuHour,
  currentCreditsPerGbMemoryHour,
}: {
  organizationId: string;
  organizationName: string;
  currentCreditsPerVcpuHour: number;
  currentCreditsPerGbMemoryHour: number;
}) {
  const { data: reference, isPending: referencePending } = useAdminComputePricingReference(true);
  const updateComputePricing = useUpdateComputePricing();
  const [creditsPerVcpuHour, setCreditsPerVcpuHour] = useState(String(currentCreditsPerVcpuHour));
  const [creditsPerGbMemoryHour, setCreditsPerGbMemoryHour] = useState(String(currentCreditsPerGbMemoryHour));

  // Keep the inputs in sync if the org's live rate changes underneath us (e.g. another admin
  // applied a change, or the environment/org selection changed).
  useEffect(() => {
    setCreditsPerVcpuHour(String(currentCreditsPerVcpuHour));
    setCreditsPerGbMemoryHour(String(currentCreditsPerGbMemoryHour));
  }, [currentCreditsPerVcpuHour, currentCreditsPerGbMemoryHour]);

  return (
    <div className="flex flex-col gap-2 border-t border-border-dim px-4 py-3">
      <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
        AWS pricing reference
      </span>
      {referencePending ? (
        <Skeleton className="h-5 w-full" />
      ) : reference == null || reference.length === 0 ? (
        <span className="text-2xs text-text-secondary">No reference data yet - the weekly sync hasn't run.</span>
      ) : (
        <div className="flex flex-col gap-1">
          {reference.map((row) => (
            <div key={row.pool} className="flex flex-wrap items-center gap-3 font-mono text-2xs text-text-secondary">
              <span className="w-16 shrink-0 text-text-primary">{row.pool}</span>
              <span>${row.usdPerVcpuHour.toFixed(5)}/vCPU-hr</span>
              <span>${row.usdPerGbHour.toFixed(5)}/GB-hr</span>
              {row.spotFraction != null && (
                <span>
                  {(row.spotFraction * 100).toFixed(0)}% spot (n={row.sampleSize})
                </span>
              )}
              <span className="ml-auto">updated {formatRelativeTime(row.updatedAt)}</span>
            </div>
          ))}
        </div>
      )}

      <span className="mt-2 font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
        {organizationName}'s billed rate
      </span>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          updateComputePricing.mutate({
            organizationId,
            creditsPerVcpuHour: Number(creditsPerVcpuHour),
            creditsPerGbMemoryHour: Number(creditsPerGbMemoryHour),
          });
        }}
      >
        <label htmlFor="credits-per-vcpu-hour" className="flex items-center gap-1.5 text-2xs text-text-secondary">
          credits/vCPU-hr
          <Input
            id="credits-per-vcpu-hour"
            type="number"
            min={0}
            step="any"
            value={creditsPerVcpuHour}
            onChange={(event) => setCreditsPerVcpuHour(event.target.value)}
            className="h-7 w-24 font-mono text-xs"
          />
        </label>
        <label htmlFor="credits-per-gb-hour" className="flex items-center gap-1.5 text-2xs text-text-secondary">
          credits/GB-hr
          <Input
            id="credits-per-gb-hour"
            type="number"
            min={0}
            step="any"
            value={creditsPerGbMemoryHour}
            onChange={(event) => setCreditsPerGbMemoryHour(event.target.value)}
            className="h-7 w-24 font-mono text-xs"
          />
        </label>
        <Button type="submit" variant="outline" size="xs" disabled={updateComputePricing.isPending}>
          {updateComputePricing.isPending ? "Saving..." : "Save"}
        </Button>
      </form>
    </div>
  );
}
