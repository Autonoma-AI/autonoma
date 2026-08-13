import { Button } from "@autonoma/blacklight";
import { CrownSimpleIcon } from "@phosphor-icons/react/CrownSimple";
import { useQuery } from "@tanstack/react-query";
import { CHECKOUT_TYPE_SUBSCRIPTION } from "lib/billing/formatters";
import { useCreateCheckoutSession } from "lib/query/billing.queries";
import { trpc } from "lib/trpc";

const SUBSCRIBED_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);

function isSubscribedStatus(status: string | undefined): boolean {
  return status != null && SUBSCRIBED_STATUSES.has(status);
}

/**
 * Renders nothing once the organization is paying, so the bar's one solid call to action is only there while
 * there is something to call for. The billing destination itself is not conditional - it lives in the account
 * menu, which is where someone who already pays goes looking for it.
 *
 * The checkout URL is Stripe's, so leaving the SPA for it is the point rather than a routing mistake.
 */
export function UpgradeButton() {
  const { data } = useQuery(trpc.billing.status.queryOptions());
  const createCheckout = useCreateCheckoutSession();

  if (data == null || isSubscribedStatus(data.subscriptionStatus)) return undefined;

  function handleUpgrade() {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    createCheckout.mutate(
      { type: CHECKOUT_TYPE_SUBSCRIPTION, returnPath },
      {
        onSuccess: (result) => {
          if (result.url == null) return;
          window.location.href = result.url;
        },
      },
    );
  }

  return (
    // The label drops at the same width the suite-health pill does, so the two calls to action narrow together
    // rather than one at a time. The crown and the fill colour still read as "upgrade" without it.
    <Button
      variant="cta"
      size="sm"
      onClick={handleUpgrade}
      disabled={createCheckout.isPending}
      aria-label="Upgrade"
      className="shrink-0 gap-1.5"
    >
      <CrownSimpleIcon size={13} weight="fill" />
      <span className="hidden lg:inline">Upgrade</span>
    </Button>
  );
}
