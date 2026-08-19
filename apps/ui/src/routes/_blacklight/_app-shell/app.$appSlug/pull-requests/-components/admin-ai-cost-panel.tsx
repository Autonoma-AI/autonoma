import { Badge, Skeleton } from "@autonoma/blacklight";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CoinsIcon } from "@phosphor-icons/react/Coins";
import { formatMicrodollars } from "lib/format";
import { useAdminBranchAiCost } from "lib/query/admin.queries";

/**
 * Admin-only breakdown of AI cost recorded against this branch, by tag. Rendered only for
 * admins - `useAdminBranchAiCost` is a plain (non-suspense) query gated by the caller, so a
 * non-admin viewing the same PR never issues the FORBIDDEN request in the first place.
 * Collapsible (native `<details>`, matching `CompactTestsRun`'s sections elsewhere on this
 * page); `defaultOpen` starts it expanded for the dedicated Usage tab.
 */
export function AdminAiCostPanel({ branchId, defaultOpen = false }: { branchId: string; defaultOpen?: boolean }) {
  const { data, isPending, isError } = useAdminBranchAiCost(branchId, true);

  // Quiet on failure - this is a bonus operational panel, not core PR content.
  if (isError) return null;

  return (
    <details className="group border border-border-dim bg-surface-base" open={defaultOpen ? true : undefined}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3">
        <CaretRightIcon size={12} className="shrink-0 text-text-tertiary transition-transform group-open:rotate-90" />
        <CoinsIcon size={14} className="shrink-0 text-text-secondary" />
        <span className="font-mono text-xs font-semibold uppercase tracking-widest text-text-primary">AI cost</span>
        <Badge variant="outline" className="font-mono text-2xs uppercase tracking-wider">
          Admin
        </Badge>
        {data != null && (
          <span className="ml-auto font-mono text-2xs tabular-nums text-text-secondary">
            {data.totalCalls} calls · {formatMicrodollars(data.totalCostMicrodollars)}
          </span>
        )}
      </summary>
      <div className="border-t border-border-dim">
        {isPending ? (
          <AdminAiCostPanelSkeleton />
        ) : data.byTag.length === 0 ? (
          <div className="p-4 text-sm text-text-secondary">No AI calls recorded for this branch yet.</div>
        ) : (
          <div className="flex flex-col">
            {data.byTag.map((tag) => (
              <div
                key={tag.tag}
                className="flex flex-wrap items-center gap-3 border-b border-border-dim px-4 py-2 last:border-b-0"
              >
                <Badge variant="outline" className="font-mono text-2xs">
                  {tag.tag}
                </Badge>
                <span className="font-mono text-2xs text-text-secondary">{tag.calls} calls</span>
                <span className="ml-auto font-mono text-xs text-text-primary">
                  {formatMicrodollars(tag.costMicrodollars)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function AdminAiCostPanelSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-4">
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-full" />
    </div>
  );
}
