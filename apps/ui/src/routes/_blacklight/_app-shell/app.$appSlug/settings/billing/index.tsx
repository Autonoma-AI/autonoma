import { createFileRoute } from "@tanstack/react-router";
import { RouteErrorState } from "components/route-error-state";
import { Suspense } from "react";
import { OrgScopeNote } from "../-org-scope-note";
import { BillingPanel } from "./-billing-panel";
import { BillingSkeleton } from "./-billing-skeleton";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/settings/billing/")({
  errorComponent: ({ reset }) => <RouteErrorState message="We couldn't load your billing." reset={reset} />,
  component: BillingPage,
});

/**
 * Credits and plan. `trpc.billing.status` takes no application id: there is one balance per organization,
 * which the scope note says rather than leaving the URL to imply otherwise.
 */
function BillingPage() {
  return (
    <div className="flex flex-col gap-4">
      <OrgScopeNote>Credits and billing are shared.</OrgScopeNote>
      <Suspense fallback={<BillingSkeleton />}>
        <BillingPanel />
      </Suspense>
    </div>
  );
}
