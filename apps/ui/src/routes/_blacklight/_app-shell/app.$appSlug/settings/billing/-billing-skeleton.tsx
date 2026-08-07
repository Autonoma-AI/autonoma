import { Panel, PanelBody, PanelHeader, Skeleton } from "@autonoma/blacklight";

/** The four credit-balance cards, as the skeleton's stand-in grid. */
const STAT_CARDS = ["total", "subscription", "topup", "cli"];

/**
 * Mirrors the billing panel's two grids - four stat cards, then the wide panels - so the numbers land in
 * cards whose outlines were already on screen. The card chrome is painted for real and only its contents
 * stand in, since a panel's border and header are static and already known.
 *
 * Before this route existed, `useBillingStatus` suspended with no boundary anywhere above it, so billing
 * rendered nothing at all while it loaded.
 */
export function BillingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {STAT_CARDS.map((id) => (
          <Panel key={id}>
            <PanelHeader>
              <Skeleton className="h-4 w-32" />
            </PanelHeader>
            <PanelBody>
              <Skeleton className="h-9 w-24" />
            </PanelBody>
          </Panel>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}
