import { Button, Input, Label, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { useUpdateVercelOverageCap, useVercelOverageStatus } from "lib/query/billing.queries";
import { Suspense, useEffect, useState } from "react";

function VercelOverageSection() {
  const { data } = useVercelOverageStatus();
  const updateCap = useUpdateVercelOverageCap();
  const [capInput, setCapInput] = useState(data.maxOverageAmountUsd != null ? String(data.maxOverageAmountUsd) : "");

  useEffect(() => {
    setCapInput(data.maxOverageAmountUsd != null ? String(data.maxOverageAmountUsd) : "");
  }, [data.maxOverageAmountUsd]);

  // The org's current plan has no pay-per-usage overage rate configured (e.g. Free) - nothing to set here.
  if (data.overagePricePerCredit == null) return null;

  const trimmedInput = capInput.trim();
  const parsedCap = trimmedInput.length > 0 ? Number.parseInt(trimmedInput, 10) : undefined;
  const isValidCap = trimmedInput.length === 0 || (Number.isInteger(parsedCap) && (parsedCap ?? 0) > 0);
  const capChanged = parsedCap !== data.maxOverageAmountUsd;

  function handleSave() {
    if (!isValidCap) return;
    updateCap.mutate({ maxOverageAmountUsd: parsedCap });
  }

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Pay-per-usage overage</PanelTitle>
      </PanelHeader>
      <PanelBody className="space-y-4">
        <p className="text-sm text-text-secondary">
          {data.enabled
            ? `Once your plan's included credits run out, usage keeps running and is billed at $${data.overagePricePerCredit}/credit, up to the monthly cap below.`
            : "By default, usage stops once your plan's included credits run out. Set a monthly cap to let usage continue - billed per credit - past that point."}
        </p>

        <div className="space-y-2">
          <Label htmlFor="billing-overage-cap">Monthly overage cap (USD)</Label>
          <Input
            id="billing-overage-cap"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            placeholder="No cap - overage disabled"
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            aria-label="billing-overage-cap"
            className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <p className="text-2xs text-text-secondary">
            Leave empty to disable overage - usage hard-stops at your plan's included credits, same as today.
          </p>
        </div>

        {data.enabled && (
          <p className="font-mono text-3xs text-text-secondary">
            This period: {data.overageCreditsGrantedThisPeriod.toLocaleString()} extra credits (~$
            {data.overageAmountUsdThisPeriod.toFixed(2)})
          </p>
        )}

        <Button
          variant="outline"
          onClick={handleSave}
          disabled={!isValidCap || !capChanged || updateCap.isPending}
          aria-label="billing-overage-cap-save"
        >
          Save usage cap
        </Button>
      </PanelBody>
    </Panel>
  );
}

function VercelOverageSectionSkeleton() {
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Pay-per-usage overage</PanelTitle>
      </PanelHeader>
      <PanelBody className="space-y-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-32" />
      </PanelBody>
    </Panel>
  );
}

export function VercelOveragePanel() {
  return (
    <Suspense fallback={<VercelOverageSectionSkeleton />}>
      <VercelOverageSection />
    </Suspense>
  );
}
