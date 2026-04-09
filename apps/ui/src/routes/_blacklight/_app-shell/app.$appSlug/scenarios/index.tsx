import {
  Badge,
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  Input,
  Label,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  ScrollArea,
  Separator,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@autonoma/blacklight";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { BroadcastIcon } from "@phosphor-icons/react/Broadcast";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { FingerprintIcon } from "@phosphor-icons/react/Fingerprint";
import { FlaskIcon } from "@phosphor-icons/react/Flask";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { WebhooksLogoIcon } from "@phosphor-icons/react/WebhooksLogo";
import { XIcon } from "@phosphor-icons/react/X";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useAPIMutation } from "lib/query/api-queries";
import { ensureScenariosData } from "lib/query/scenarios.queries";
import { trpc } from "lib/trpc";
import { useState } from "react";
import { Suspense } from "react";
import { useCurrentApplication } from "../../-use-current-application";
import { SettingsTabNav } from "../settings/-settings-tab-nav";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/scenarios/")({
  loader: ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    return ensureScenariosData(context.queryClient, app.id);
  },
  component: ScenariosPage,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffSeconds < 60) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

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

type WebhookActionType = "DISCOVER" | "UP" | "DOWN";

function webhookActionBadgeVariant(action: WebhookActionType): "outline" | "success" | "warn" {
  switch (action) {
    case "DISCOVER":
      return "outline";
    case "UP":
      return "success";
    case "DOWN":
      return "warn";
  }
}

// ---------------------------------------------------------------------------
// Table header style
// ---------------------------------------------------------------------------

const TH = "px-4 py-2.5 text-left font-mono text-2xs font-medium uppercase tracking-widest text-text-tertiary";

// ---------------------------------------------------------------------------
// Configure Webhook Dialog
// ---------------------------------------------------------------------------

function ConfigureWebhookDialog({
  open,
  onOpenChange,
  applicationId,
  deploymentId,
  initialUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  deploymentId?: string;
  initialUrl?: string;
}) {
  const queryClient = useQueryClient();
  const [webhookUrl, setWebhookUrl] = useState(initialUrl ?? "");
  const [customHeaders, setCustomHeaders] = useState<Array<{ key: string; value: string }>>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const configureWebhook = useAPIMutation({
    ...trpc.scenarios.configureWebhook.mutationOptions({
      onSettled: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.scenarios.list.queryKey({ applicationId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.scenarios.listWebhookCalls.queryKey({
            applicationId,
          }),
        });
        void queryClient.invalidateQueries({
          queryKey: ["applications"],
        });
      },
    }),
    successToast: { title: "Webhook configured" },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (deploymentId == null) return;

    const headersRecord: Record<string, string> = {};
    for (const h of customHeaders) {
      if (h.key.length > 0) headersRecord[h.key] = h.value;
    }
    const webhookHeaders = Object.keys(headersRecord).length > 0 ? headersRecord : undefined;

    configureWebhook.mutate(
      { applicationId, deploymentId, webhookUrl, webhookHeaders },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure webhook</DialogTitle>
          <DialogDescription>Enter the webhook URL for your scenario endpoint.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="webhook-url">Webhook URL</Label>
              <Input
                id="webhook-url"
                type="url"
                placeholder="https://your-app.com/api/scenarios"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                required
              />
            </div>

            {/* Advanced: Custom Headers */}
            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced((prev) => !prev)}
                className="flex items-center gap-1.5 font-mono text-2xs text-text-tertiary transition-colors hover:text-text-secondary"
              >
                <CaretDownIcon
                  size={12}
                  className={cn("transition-transform", showAdvanced ? "rotate-0" : "-rotate-90")}
                />
                Advanced
              </button>

              {showAdvanced && (
                <div className="mt-3 space-y-3">
                  <label className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
                    Custom Headers
                  </label>
                  {customHeaders.map((header, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        type="text"
                        value={header.key}
                        onChange={(e) => {
                          const next = [...customHeaders];
                          next[index] = { ...header, key: e.target.value };
                          setCustomHeaders(next);
                        }}
                        placeholder="Header name"
                        className="flex-1"
                      />
                      <Input
                        type="text"
                        value={header.value}
                        onChange={(e) => {
                          const next = [...customHeaders];
                          next[index] = { ...header, value: e.target.value };
                          setCustomHeaders(next);
                        }}
                        placeholder="Value"
                        className="flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => setCustomHeaders(customHeaders.filter((_, i) => i !== index))}
                        className="flex size-9 shrink-0 items-center justify-center text-text-tertiary transition-colors hover:text-status-critical"
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setCustomHeaders([...customHeaders, { key: "", value: "" }])}
                    className="flex items-center gap-1.5 font-mono text-2xs text-text-tertiary transition-colors hover:text-primary-ink"
                  >
                    <PlusIcon size={12} />
                    Add header
                  </button>
                </div>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={configureWebhook.isPending}>
              {configureWebhook.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Remove Webhook Dialog
// ---------------------------------------------------------------------------

function RemoveWebhookDialog({
  open,
  onOpenChange,
  applicationId,
  deploymentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  deploymentId: string;
}) {
  const queryClient = useQueryClient();

  const removeWebhook = useAPIMutation({
    ...trpc.scenarios.removeWebhook.mutationOptions({
      onSettled: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.scenarios.list.queryKey({ applicationId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.scenarios.listWebhookCalls.queryKey({
            applicationId,
          }),
        });
        void queryClient.invalidateQueries({
          queryKey: ["applications"],
        });
      },
    }),
    successToast: { title: "Webhook removed" },
  });

  function handleConfirm() {
    removeWebhook.mutate(
      { applicationId, deploymentId },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove webhook</DialogTitle>
          <DialogDescription>
            This will remove the webhook configuration and delete all discovered scenarios. This action cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={handleConfirm} disabled={removeWebhook.isPending}>
            {removeWebhook.isPending ? "Removing..." : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Webhook Status Bar
// ---------------------------------------------------------------------------

function WebhookStatusBar({
  webhookUrl,
  applicationId,
  deploymentId,
  onConfigure,
  onRemove,
}: {
  webhookUrl: string;
  applicationId: string;
  deploymentId: string;
  onConfigure: () => void;
  onRemove: () => void;
}) {
  const queryClient = useQueryClient();

  const discover = useAPIMutation({
    ...trpc.scenarios.discover.mutationOptions({
      onSettled: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.scenarios.list.queryKey({ applicationId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.scenarios.listWebhookCalls.queryKey({
            applicationId,
          }),
        });
      },
    }),
    successToast: { title: "Scenarios discovered" },
  });

  function handleDiscover() {
    discover.mutate({ applicationId, deploymentId });
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border-dim bg-surface-base px-4 py-3">
      <GlobeIcon size={16} className="shrink-0 text-text-tertiary" />
      <span className="min-w-0 flex-1 truncate font-mono text-sm text-text-secondary">{webhookUrl}</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleDiscover} disabled={discover.isPending}>
          {discover.isPending ? (
            <CircleNotchIcon size={14} className="animate-spin" />
          ) : (
            <MagnifyingGlassIcon size={14} />
          )}
          Discover
        </Button>
        <Button variant="outline" size="sm" onClick={onConfigure}>
          <ArrowsClockwiseIcon size={14} />
          Configure
        </Button>
        <Button variant="outline" size="sm" onClick={onRemove}>
          <TrashIcon size={14} />
          Remove
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenario Drawer
// ---------------------------------------------------------------------------

type ScenarioData = {
  id: string;
  name: string;
  description?: string | null;
  lastSeenFingerprint?: string | null;
  lastDiscoveredAt?: Date | string | null;
  fingerprintChangedAt?: Date | string | null;
  isDisabled?: boolean;
  createdAt?: Date | string;
};

function ScenarioDrawer({
  scenario,
  open,
  onOpenChange,
}: {
  scenario: ScenarioData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Drawer side="right" open={open} onOpenChange={onOpenChange}>
      <DrawerBackdrop />
      <DrawerContent side="right" className="flex w-[480px] max-w-[90vw] flex-col gap-0 p-0">
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 py-5">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-3xs font-medium uppercase tracking-wider text-text-tertiary">Scenario</span>
            <h2 className="font-sans text-base font-semibold text-text-primary">{scenario.name}</h2>
            {scenario.isDisabled === true && (
              <Badge variant="secondary" className="w-fit">
                Disabled
              </Badge>
            )}
          </div>
          <DrawerClose render={<Button variant="ghost" size="icon-xs" className="mt-0.5 shrink-0" />}>
            <XIcon size={14} />
          </DrawerClose>
        </div>

        <Separator />

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-6 px-6 py-5">
            {scenario.description != null && (
              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-3xs font-medium uppercase tracking-wider text-text-tertiary">
                  Description
                </span>
                <p className="font-sans text-sm leading-relaxed text-text-secondary">{scenario.description}</p>
              </div>
            )}

            <div className="flex flex-col gap-3">
              <span className="font-mono text-3xs font-medium uppercase tracking-wider text-text-tertiary">
                Details
              </span>
              <div className="flex flex-col divide-y divide-border-dim border border-border-dim">
                {scenario.lastSeenFingerprint != null && (
                  <div className="flex items-center justify-between gap-4 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <FingerprintIcon size={13} className="shrink-0 text-text-tertiary" />
                      <span className="font-mono text-2xs text-text-tertiary">Fingerprint</span>
                    </div>
                    <span className="font-mono text-2xs text-text-primary">{scenario.lastSeenFingerprint}</span>
                  </div>
                )}
                {scenario.lastDiscoveredAt != null && (
                  <div className="flex items-center justify-between gap-4 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <ClockIcon size={13} className="shrink-0 text-text-tertiary" />
                      <span className="font-mono text-2xs text-text-tertiary">Last discovered</span>
                    </div>
                    <span className="font-mono text-2xs text-text-secondary">
                      {formatRelativeTime(new Date(scenario.lastDiscoveredAt))}
                    </span>
                  </div>
                )}
                {scenario.fingerprintChangedAt != null && (
                  <div className="flex items-center justify-between gap-4 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <ClockIcon size={13} className="shrink-0 text-text-tertiary" />
                      <span className="font-mono text-2xs text-text-tertiary">Fingerprint changed</span>
                    </div>
                    <span className="font-mono text-2xs text-text-secondary">
                      {formatRelativeTime(new Date(scenario.fingerprintChangedAt))}
                    </span>
                  </div>
                )}
                {scenario.createdAt != null && (
                  <div className="flex items-center justify-between gap-4 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <ClockIcon size={13} className="shrink-0 text-text-tertiary" />
                      <span className="font-mono text-2xs text-text-tertiary">Created</span>
                    </div>
                    <span className="font-mono text-2xs text-text-secondary">
                      {formatRelativeTime(new Date(scenario.createdAt))}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <span className="font-mono text-3xs font-medium uppercase tracking-wider text-text-tertiary">
                Instances
              </span>
              <Suspense fallback={<InstancesDrawerSkeleton />}>
                <ScenarioInstancesList scenarioId={scenario.id} />
              </Suspense>
            </div>
          </div>
        </ScrollArea>
      </DrawerContent>
    </Drawer>
  );
}

function ScenarioInstancesList({ scenarioId }: { scenarioId: string }) {
  const { data: instances } = useSuspenseQuery(trpc.scenarios.listInstances.queryOptions({ scenarioId }));

  if (instances.length === 0) {
    return <p className="font-mono text-2xs text-text-tertiary">No instances yet.</p>;
  }

  return (
    <div className="flex flex-col divide-y divide-border-dim border border-border-dim">
      {instances.map((instance) => (
        <div key={instance.id} className="flex flex-col gap-2 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-2xs text-text-tertiary">{instance.id.slice(0, 12)}</span>
            <Badge variant={instanceStatusBadgeVariant(instance.status as InstanceStatus)}>
              {instance.status.replace(/_/g, " ")}
            </Badge>
          </div>
          <div className="flex gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-3xs text-text-tertiary">Requested</span>
              <span className="font-mono text-2xs text-text-secondary">
                {formatRelativeTime(new Date(instance.requestedAt))}
              </span>
            </div>
            {instance.upAt != null && (
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-3xs text-text-tertiary">Up</span>
                <span className="font-mono text-2xs text-text-secondary">
                  {formatRelativeTime(new Date(instance.upAt))}
                </span>
              </div>
            )}
            {instance.completedAt != null && (
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-3xs text-text-tertiary">Completed</span>
                <span className="font-mono text-2xs text-text-secondary">
                  {formatRelativeTime(new Date(instance.completedAt))}
                </span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function InstancesDrawerSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenario Row
// ---------------------------------------------------------------------------

function ScenarioRow({ scenario, applicationId }: { scenario: ScenarioData; applicationId: string }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const queryClient = useQueryClient();

  const dryRun = useAPIMutation({
    ...trpc.scenarios.dryRun.mutationOptions({
      onSettled: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.scenarios.listWebhookCalls.queryKey({ applicationId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.scenarios.listInstances.queryKey({ scenarioId: scenario.id }),
        });
      },
    }),
    successToast: { title: "Dry run passed" },
  });

  function handleDryRun(e: React.MouseEvent) {
    e.stopPropagation();
    dryRun.mutate({ applicationId, scenarioId: scenario.id });
  }

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border-dim transition-colors hover:bg-surface-raised"
        onClick={() => setDrawerOpen(true)}
      >
        <td className="px-4 py-3">
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-text-primary">{scenario.name}</span>
            {scenario.description != null && (
              <span className="truncate text-2xs text-text-tertiary">{scenario.description}</span>
            )}
          </div>
        </td>
        <td className="px-4 py-3">
          {scenario.lastSeenFingerprint != null ? (
            <div className="flex items-center gap-1.5">
              <FingerprintIcon size={14} className="shrink-0 text-text-tertiary" />
              <span className="font-mono text-2xs text-text-secondary">
                {scenario.lastSeenFingerprint.slice(0, 12)}
              </span>
            </div>
          ) : (
            <span className="text-sm text-text-tertiary">-</span>
          )}
        </td>
        <td className="px-4 py-3">
          {scenario.lastDiscoveredAt != null ? (
            <div className="flex items-center gap-1.5">
              <ClockIcon size={14} className="shrink-0 text-text-tertiary" />
              <span className="text-sm text-text-secondary">
                {formatRelativeTime(new Date(scenario.lastDiscoveredAt))}
              </span>
            </div>
          ) : (
            <span className="text-sm text-text-tertiary">-</span>
          )}
        </td>
        <td className="px-4 py-3">
          <Button variant="outline" size="sm" onClick={handleDryRun} disabled={dryRun.isPending}>
            {dryRun.isPending ? <CircleNotchIcon size={14} className="animate-spin" /> : <FlaskIcon size={14} />}
            Try it
          </Button>
        </td>
      </tr>
      <ScenarioDrawer scenario={scenario} open={drawerOpen} onOpenChange={setDrawerOpen} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Scenarios Table
// ---------------------------------------------------------------------------

function ScenariosTable({ applicationId }: { applicationId: string }) {
  const { data: scenarios } = useSuspenseQuery(
    trpc.scenarios.list.queryOptions({ applicationId }, { refetchInterval: 10000 }),
  );

  if (scenarios.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <BroadcastIcon size={32} className="text-text-tertiary" />
        <div>
          <p className="text-sm font-medium text-text-primary">No scenarios discovered</p>
          <p className="mt-1 text-2xs text-text-tertiary">Click Discover to fetch scenarios from your webhook</p>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      <table className="w-full min-w-100 table-fixed text-sm">
        <thead className="sticky top-0 z-10 border-b border-border-dim bg-surface-base">
          <tr>
            <th className={`${TH} w-4/12`}>Scenario</th>
            <th className={`${TH} w-3/12`}>Fingerprint</th>
            <th className={`${TH} w-3/12`}>Last discovered</th>
            <th className={`${TH} w-2/12`} />
          </tr>
        </thead>
        <tbody>
          {scenarios.map((scenario) => (
            <ScenarioRow key={scenario.id} scenario={scenario} applicationId={applicationId} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Webhook Calls Table
// ---------------------------------------------------------------------------

function truncateBody(body: unknown): string {
  if (body == null) return "-";
  const json = JSON.stringify(body);
  if (json.length <= 80) return json;
  return `${json.slice(0, 80)}…`;
}

function WebhookCallsTable({ applicationId }: { applicationId: string }) {
  const { data: calls } = useSuspenseQuery(
    trpc.scenarios.listWebhookCalls.queryOptions({ applicationId }, { refetchInterval: 10000 }),
  );

  if (calls.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <GlobeIcon size={32} className="text-text-tertiary" />
        <div>
          <p className="text-sm font-medium text-text-primary">No webhook calls yet</p>
          <p className="mt-1 text-2xs text-text-tertiary">
            Webhook calls will appear here when scenarios are triggered
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      <table className="w-full min-w-100 table-fixed text-sm">
        <thead className="sticky top-0 z-10 border-b border-border-dim bg-surface-base">
          <tr>
            <th className={`${TH} w-2/12`}>Action</th>
            <th className={`${TH} w-1/12`}>Status</th>
            <th className={`${TH} w-1/12`}>Duration</th>
            <th className={`${TH} w-4/12`}>Body</th>
            <th className={`${TH} w-2/12`}>Error</th>
            <th className={`${TH} w-2/12`}>Time</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call) => (
            <tr key={call.id} className="border-b border-border-dim last:border-0">
              <td className="px-4 py-2.5">
                <Badge variant={webhookActionBadgeVariant(call.action as WebhookActionType)}>{call.action}</Badge>
              </td>
              <td className="px-4 py-2.5">
                {call.statusCode != null ? (
                  <span
                    className={cn(
                      "font-mono text-sm",
                      call.statusCode >= 200 && call.statusCode < 300 ? "text-status-success" : "text-status-critical",
                    )}
                  >
                    {call.statusCode}
                  </span>
                ) : (
                  <span className="text-sm text-text-tertiary">-</span>
                )}
              </td>
              <td className="px-4 py-2.5">
                {call.durationMs != null ? (
                  <span className="font-mono text-sm text-text-secondary">{call.durationMs}ms</span>
                ) : (
                  <span className="text-sm text-text-tertiary">-</span>
                )}
              </td>
              <td className="px-4 py-2.5">
                {call.responseBody != null ? (
                  <span className="block truncate font-mono text-2xs text-text-tertiary">
                    {truncateBody(call.responseBody)}
                  </span>
                ) : (
                  <span className="text-sm text-text-tertiary">-</span>
                )}
              </td>
              <td className="px-4 py-2.5">
                {call.error != null ? (
                  <div className="flex items-center gap-1.5">
                    <WarningIcon size={14} className="shrink-0 text-status-critical" />
                    <span className="truncate text-sm text-status-critical">{call.error}</span>
                  </div>
                ) : (
                  <span className="text-sm text-text-tertiary">-</span>
                )}
              </td>
              <td className="px-4 py-2.5">
                <span className="text-sm text-text-secondary">{formatRelativeTime(new Date(call.createdAt))}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content Skeleton
// ---------------------------------------------------------------------------

function ContentSkeleton() {
  return (
    <Panel>
      <PanelBody className="p-4">
        <div className="flex flex-col gap-3">
          {["sk-1", "sk-2", "sk-3", "sk-4", "sk-5"].map((id) => (
            <Skeleton key={id} className="h-10 w-full" />
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Webhook Configured Content
// ---------------------------------------------------------------------------

function WebhookConfiguredContent({
  webhookUrl,
  applicationId,
  deploymentId,
}: {
  webhookUrl: string;
  applicationId: string;
  deploymentId: string;
}) {
  const [configureOpen, setConfigureOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  return (
    <>
      <WebhookStatusBar
        webhookUrl={webhookUrl}
        applicationId={applicationId}
        deploymentId={deploymentId}
        onConfigure={() => setConfigureOpen(true)}
        onRemove={() => setRemoveOpen(true)}
      />

      <Tabs defaultValue="scenarios">
        <TabsList>
          <TabsTrigger value="scenarios">
            <BroadcastIcon size={14} />
            Scenarios
          </TabsTrigger>
          <TabsTrigger value="webhook-calls">
            <WebhooksLogoIcon size={14} />
            Webhook calls
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scenarios">
          <Panel>
            <PanelHeader className="flex items-center gap-2">
              <BroadcastIcon size={14} className="text-text-tertiary" />
              <PanelTitle>Discovered scenarios</PanelTitle>
            </PanelHeader>
            <PanelBody className="p-0">
              <Suspense fallback={<ContentSkeleton />}>
                <ScenariosTable applicationId={applicationId} />
              </Suspense>
            </PanelBody>
          </Panel>
        </TabsContent>

        <TabsContent value="webhook-calls">
          <Panel>
            <PanelHeader className="flex items-center gap-2">
              <WebhooksLogoIcon size={14} className="text-text-tertiary" />
              <PanelTitle>Recent webhook calls</PanelTitle>
            </PanelHeader>
            <PanelBody className="p-0">
              <Suspense fallback={<ContentSkeleton />}>
                <WebhookCallsTable applicationId={applicationId} />
              </Suspense>
            </PanelBody>
          </Panel>
        </TabsContent>
      </Tabs>

      <ConfigureWebhookDialog
        open={configureOpen}
        onOpenChange={setConfigureOpen}
        applicationId={applicationId}
        deploymentId={deploymentId}
        initialUrl={webhookUrl}
      />
      <RemoveWebhookDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        applicationId={applicationId}
        deploymentId={deploymentId}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Empty State (no webhook configured)
// ---------------------------------------------------------------------------

function EmptyState({ applicationId, deploymentId }: { applicationId: string; deploymentId?: string }) {
  const [configureOpen, setConfigureOpen] = useState(false);

  return (
    <>
      <Panel>
        <PanelBody className="flex flex-col items-center gap-4 py-16">
          <div className="flex size-12 items-center justify-center rounded-full border border-border-dim bg-surface-raised">
            <WebhooksLogoIcon size={24} className="text-text-tertiary" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-text-primary">No webhook configured</p>
            <p className="mt-1 max-w-sm text-2xs text-text-tertiary">
              Configure a webhook to enable scenario discovery and automated environment management for your
              application.
            </p>
          </div>
          <Button onClick={() => setConfigureOpen(true)}>
            <WebhooksLogoIcon size={14} />
            Configure webhook
          </Button>
        </PanelBody>
      </Panel>

      <ConfigureWebhookDialog
        open={configureOpen}
        onOpenChange={setConfigureOpen}
        applicationId={applicationId}
        deploymentId={deploymentId}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ScenariosPage() {
  const { appSlug } = Route.useParams();
  const app = useCurrentApplication();
  const deployment = (app as { mainBranch?: { deployment?: { id: string; webhookUrl?: string | null } | null } | null })
    .mainBranch?.deployment;
  const webhookUrl = deployment?.webhookUrl;
  const deploymentId = deployment?.id;
  const hasWebhook = webhookUrl != null && webhookUrl !== "" && deploymentId != null;

  return (
    <div className="flex flex-col gap-6">
      <SettingsTabNav activeTab="scenarios" appSlug={appSlug} />

      {hasWebhook ? (
        <WebhookConfiguredContent webhookUrl={webhookUrl} applicationId={app.id} deploymentId={deploymentId} />
      ) : (
        <EmptyState applicationId={app.id} deploymentId={deploymentId} />
      )}
    </div>
  );
}
