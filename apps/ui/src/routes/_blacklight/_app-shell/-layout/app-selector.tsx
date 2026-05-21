import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@autonoma/blacklight";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CaretUpDownIcon } from "@phosphor-icons/react/CaretUpDown";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useNavigate, useParams, useRouteContext } from "@tanstack/react-router";
import { navigateToOnboarding } from "lib/onboarding/navigate-to-onboarding";
import { useDeleteApplication } from "lib/query/applications.queries";
import { useState } from "react";

function DiscardConfirmDialog({
  appName,
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: {
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discard application?</DialogTitle>
          <DialogDescription>
            This will permanently delete <strong>{appName}</strong> and all its data. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            }
          />
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={isPending}>
            {isPending ? "Discarding..." : "Discard"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AppSelector({ currentApp, collapsed }: { currentApp: { slug: string; name: string }; collapsed: boolean }) {
  const applications = useRouteContext({ from: "/_blacklight/_app-shell", select: (ctx) => ctx.applications });
  const navigate = useNavigate();
  const deleteApp = useDeleteApplication();
  const [discardTarget, setDiscardTarget] = useState<{ id: string; name: string }>();

  const incompleteApps = applications.filter(
    (app) => app.onboardingState != null && app.onboardingState.step !== "completed",
  );
  const completedApps = applications.filter(
    (app) => app.onboardingState == null || app.onboardingState.step === "completed",
  );

  const trigger = collapsed ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={`Switch app (current: ${currentApp.name})`}
                className="flex w-full items-center justify-center rounded px-2 py-1.5 text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
              >
                <AppWindowIcon size={18} />
              </button>
            }
          />
        }
      />
      <TooltipContent side="right">{currentApp.name}</TooltipContent>
    </Tooltip>
  ) : (
    <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-xs font-medium text-text-primary transition-colors hover:bg-surface-raised">
      <span className="block size-2 shrink-0 rounded-sm bg-primary" />
      <span className="truncate">{currentApp.name}</span>
      <CaretUpDownIcon size={12} className="ml-auto shrink-0 text-text-tertiary" />
    </DropdownMenuTrigger>
  );

  return (
    <>
      <DropdownMenu>
        {trigger}
        <DropdownMenuContent align="start" className="max-h-[70vh] overflow-y-auto">
          <DropdownMenuItem
            className="gap-1.5 border border-dashed border-border-mid text-primary"
            onClick={() => {
              void navigate({ to: "/onboarding", search: { step: "install", appId: undefined } });
            }}
          >
            <PlusIcon size={14} weight="bold" />
            Add app
          </DropdownMenuItem>

          {incompleteApps.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuGroupLabel className="font-mono text-3xs uppercase tracking-widest text-text-tertiary">
                  Continue setup
                </DropdownMenuGroupLabel>
                {incompleteApps.map((app) => (
                  <DropdownMenuItem
                    key={app.id}
                    className="text-text-tertiary opacity-60 hover:opacity-100"
                    onClick={() => {
                      navigateToOnboarding(app.id, app.onboardingState?.step, navigate);
                    }}
                  >
                    <span className="truncate">{app.name}</span>
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        className="rounded p-0.5 text-text-tertiary hover:text-status-critical"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDiscardTarget({ id: app.id, name: app.name });
                        }}
                      >
                        <TrashIcon size={12} />
                      </button>
                      <ArrowRightIcon size={12} />
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          )}

          {completedApps.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {completedApps.map((app) => {
                const hasNoRepo = app.githubRepositoryId == null;
                return (
                  <DropdownMenuItem
                    key={app.id}
                    className={app.slug === currentApp.slug ? "text-primary-ink" : ""}
                    onClick={() => {
                      if (hasNoRepo) {
                        void navigate({ to: "/app/$appSlug/github", params: { appSlug: app.slug } });
                      } else {
                        void navigate({ to: "/app/$appSlug", params: { appSlug: app.slug } });
                      }
                    }}
                  >
                    <span className="flex items-center gap-2">
                      {app.name}
                      {hasNoRepo && (
                        <WarningCircleIcon size={14} weight="fill" className="shrink-0 text-status-critical" />
                      )}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DiscardConfirmDialog
        appName={discardTarget?.name ?? ""}
        open={discardTarget != null}
        onOpenChange={(open) => {
          if (!open) setDiscardTarget(undefined);
        }}
        onConfirm={() => {
          if (discardTarget == null) return;
          deleteApp.mutate({ id: discardTarget.id }, { onSuccess: () => setDiscardTarget(undefined) });
        }}
        isPending={deleteApp.isPending}
      />
    </>
  );
}

export function SidebarAppSelector({ collapsed }: { collapsed: boolean }) {
  const applications = useRouteContext({ from: "/_blacklight/_app-shell", select: (ctx) => ctx.applications });
  const params = useParams({ strict: false }) as { appSlug?: string };

  if (params.appSlug == null) return null;

  const app = applications.find((a) => a.slug === params.appSlug);
  if (app == null) return null;

  if (collapsed) {
    return <AppSelector currentApp={app} collapsed={collapsed} />;
  }

  return (
    <div className="flex flex-col gap-1 pt-4 border-t border-border-dim">
      <span className="px-1.5 font-mono text-3xs uppercase tracking-widest text-text-tertiary">App</span>
      <AppSelector currentApp={app} collapsed={collapsed} />
    </div>
  );
}
