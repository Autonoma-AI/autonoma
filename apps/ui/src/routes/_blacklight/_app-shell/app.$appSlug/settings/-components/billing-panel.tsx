import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Input,
  Label,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@autonoma/blacklight";
import { CreditCardIcon } from "@phosphor-icons/react/CreditCard";
import { CrownSimpleIcon } from "@phosphor-icons/react/CrownSimple";
import { GiftIcon } from "@phosphor-icons/react/Gift";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import {
  CHECKOUT_TYPE_SUBSCRIPTION,
  CHECKOUT_TYPE_TOPUP,
  type CheckoutType,
  formatSubscriptionStatus,
  formatTransactionType,
} from "lib/billing/formatters";
import { formatDate } from "lib/format";
import {
  useBillingStatus,
  useCreateCheckoutSession,
  useCreatePortalSession,
  useRedeemPromoCode,
  useUpdateAutoTopUp,
} from "lib/query/billing.queries";
import { toastManager } from "lib/toast-manager";
import { useEffect, useState } from "react";

const SUBSCRIBED_STATUSES = new Set(["active", "trialing"]);

export function BillingPanel() {
  const { data } = useBillingStatus();
  const createCheckout = useCreateCheckoutSession();
  const createPortal = useCreatePortalSession();
  const updateAutoTopUp = useUpdateAutoTopUp();
  const redeemPromo = useRedeemPromoCode();

  const [promoCode, setPromoCode] = useState("");
  const [autoTopUpEnabled, setAutoTopUpEnabled] = useState(data.autoTopUpEnabled);
  const [autoTopUpThreshold, setAutoTopUpThreshold] = useState(String(data.autoTopUpThreshold));

  useEffect(() => {
    setAutoTopUpEnabled(data.autoTopUpEnabled);
    setAutoTopUpThreshold(String(data.autoTopUpThreshold));
  }, [data.autoTopUpEnabled, data.autoTopUpThreshold]);

  const isSubscribed = data.subscriptionStatus != null && SUBSCRIBED_STATUSES.has(data.subscriptionStatus);

  const topupBalance = Math.max(0, data.creditBalance - data.subscriptionCreditBalance);
  const thresholdValue = Number.parseInt(autoTopUpThreshold, 10);
  const canSaveAutoTopUp =
    Number.isFinite(thresholdValue) &&
    thresholdValue >= 0 &&
    (autoTopUpEnabled !== data.autoTopUpEnabled || thresholdValue !== data.autoTopUpThreshold);

  function handleCreateCheckout(type: CheckoutType) {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    createCheckout.mutate(
      { type, returnPath },
      {
        onSuccess: (result) => {
          if (result.url == null) return;
          window.location.href = result.url;
        },
      },
    );
  }

  function handleOpenPortal() {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    createPortal.mutate(
      { returnPath },
      {
        onSuccess: (result) => {
          if (result.url == null) return;
          window.location.href = result.url;
        },
      },
    );
  }

  function handleSaveAutoTopUp() {
    if (!Number.isFinite(thresholdValue) || thresholdValue < 0) return;
    updateAutoTopUp.mutate({
      enabled: autoTopUpEnabled,
      threshold: thresholdValue,
    });
  }

  function handleRedeemPromoCode() {
    const code = promoCode.trim();
    if (code.length === 0) return;

    redeemPromo.mutate(
      { code },
      {
        onSuccess: (result) => {
          setPromoCode("");
          toastManager.add({
            type: "success",
            title: `Code applied: +${result.grantedCredits.toLocaleString()} credits`,
          });
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Panel>
          <PanelHeader>
            <PanelTitle>Total credits</PanelTitle>
          </PanelHeader>
          <PanelBody>
            <p className="text-3xl font-semibold text-text-primary">{data.creditBalance.toLocaleString()}</p>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Subscription credits</PanelTitle>
          </PanelHeader>
          <PanelBody>
            <p className="text-3xl font-semibold text-text-primary">
              {data.subscriptionCreditBalance.toLocaleString()}
            </p>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Top-up credits</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-3">
            <p className="text-3xl font-semibold text-text-primary">{topupBalance.toLocaleString()}</p>
            <Button
              variant="outline"
              onClick={() => handleCreateCheckout(CHECKOUT_TYPE_TOPUP)}
              disabled={createCheckout.isPending}
              aria-label="billing-buy-topup"
            >
              <LightningIcon size={14} />
              Buy top-up
            </Button>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle className="flex items-center gap-2">
              <TerminalWindowIcon size={14} />
              AI CLI usage
            </PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-1">
            <p className="text-3xl font-semibold text-text-primary">{data.cliCreditsSpent.toLocaleString()}</p>
            <p className="text-2xs text-text-secondary">credits spent all-time on the planner CLI</p>
          </PanelBody>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader>
            <PanelTitle>Subscription</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-4">
            <Alert>
              <AlertTitle>Status</AlertTitle>
              <AlertDescription className="flex items-center gap-2">
                <span className="rounded border border-border-dim px-2 py-1 text-2xs">
                  {formatSubscriptionStatus(data.subscriptionStatus)}
                </span>
                {data.currentPeriodEnd != null ? (
                  <span>Current period ends {formatDate(data.currentPeriodEnd)}</span>
                ) : null}
              </AlertDescription>
            </Alert>

            <div className="flex flex-wrap gap-2">
              <Tooltip>
                <TooltipTrigger render={<span />}>
                  <Button
                    onClick={() => handleCreateCheckout(CHECKOUT_TYPE_SUBSCRIPTION)}
                    disabled={isSubscribed || createCheckout.isPending}
                    aria-label="billing-start-subscription"
                  >
                    <CrownSimpleIcon size={14} />
                    Upgrade
                  </Button>
                </TooltipTrigger>
                {isSubscribed && <TooltipContent>You are already on the Pro plan</TooltipContent>}
              </Tooltip>
              <Button
                variant="outline"
                onClick={handleOpenPortal}
                disabled={createPortal.isPending}
                aria-label="billing-open-portal"
              >
                <CreditCardIcon size={14} />
                Open billing portal
              </Button>
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Auto top-up</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-4">
            <label htmlFor="billing-auto-topup-enabled" className="flex items-center gap-3">
              <Checkbox
                id="billing-auto-topup-enabled"
                checked={autoTopUpEnabled}
                onCheckedChange={(checked) => setAutoTopUpEnabled(checked === true)}
              />
              <span className="text-sm text-text-secondary">Enable automatic top-up when credits are low</span>
            </label>

            <div className="space-y-2">
              <Label htmlFor="billing-auto-topup-threshold">Threshold</Label>
              <Input
                id="billing-auto-topup-threshold"
                type="number"
                min={0}
                value={autoTopUpThreshold}
                onChange={(e) => setAutoTopUpThreshold(e.target.value)}
                aria-label="billing-auto-topup-threshold"
              />
              <p className="font-mono text-3xs text-text-tertiary">
                When balance goes below this value, a top-up payment is attempted automatically.
              </p>
            </div>

            <Button
              variant="outline"
              onClick={handleSaveAutoTopUp}
              disabled={!canSaveAutoTopUp || updateAutoTopUp.isPending}
              aria-label="billing-auto-topup-save"
            >
              Save auto top-up
            </Button>
          </PanelBody>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader>
            <PanelTitle>Gift card / promo code</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value)}
                placeholder="0bugs"
                aria-label="billing-promo-code-input"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleRedeemPromoCode();
                  }
                }}
              />
              <Button
                onClick={handleRedeemPromoCode}
                disabled={promoCode.trim().length === 0 || redeemPromo.isPending}
                aria-label="billing-promo-code-redeem"
              >
                <GiftIcon size={14} />
                Redeem
              </Button>
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Recent transactions</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-2">
            {data.transactions.length === 0 ? (
              <p className="text-sm text-text-tertiary">No transactions yet.</p>
            ) : (
              data.transactions.slice(0, 10).map((tx) => (
                <div
                  key={tx.id}
                  className="flex items-center justify-between rounded-md border border-border-dim px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-2xs text-text-primary">{formatTransactionType(tx.type)}</p>
                    <p className="font-mono text-3xs text-text-secondary">{formatDate(tx.createdAt)}</p>
                  </div>
                  <p className={`font-mono text-xs ${tx.amount >= 0 ? "text-status-success" : "text-text-primary"}`}>
                    {tx.amount > 0 ? "+" : ""}
                    {tx.amount}
                  </p>
                </div>
              ))
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
