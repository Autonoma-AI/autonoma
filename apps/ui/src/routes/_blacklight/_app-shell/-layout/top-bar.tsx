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
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useRouteContext } from "@tanstack/react-router";
import { navigateToOnboarding } from "lib/onboarding/navigate-to-onboarding";
import { useDeleteApplication } from "lib/query/applications.queries";
import { trpc } from "lib/trpc";
import { Suspense, useState } from "react";

// ─── BranchSelector ──────────────────────────────────────────────────────────

function BranchSelector({
  appSlug,
  applicationId,
  currentBranch,
}: {
  appSlug: string;
  applicationId: string;
  currentBranch: string;
}) {
  const { data: branches } = useSuspenseQuery(trpc.branches.list.queryOptions({ applicationId }));
  const navigate = useNavigate();

  if (branches.length <= 1) {
    return (
      <span className="flex items-center gap-1.5 font-mono text-2xs text-text-secondary">
        <GitBranchIcon size={12} />
        {currentBranch}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded px-2 py-1 font-mono text-2xs text-text-secondary transition-colors hover:bg-surface-base hover:text-text-primary">
        <GitBranchIcon size={12} />
        {currentBranch}
        <CaretDownIcon size={10} className="text-text-tertiary" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {branches.map((branch) => (
          <DropdownMenuItem
            key={branch.id}
            className={branch.name === currentBranch ? "text-primary-ink" : ""}
            onClick={() => {
              void navigate({ to: "/app/$appSlug/branch/$branchName", params: { appSlug, branchName: branch.name } });
            }}
          >
            <GitBranchIcon size={12} />
            {branch.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── DiscardConfirmDialog ────────────────────────────────────────────────────

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

// ─── AppSelector ─────────────────────────────────────────────────────────────

function AppSelector({ currentApp }: { currentApp: { slug: string; name: string } }) {
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-base hover:text-text-primary">
          {currentApp.name}
          <CaretDownIcon size={10} className="text-text-tertiary" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            className="gap-1.5 border border-dashed border-border-mid text-primary"
            onClick={() => {
              void navigate({ to: "/onboarding/install" });
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
              {completedApps.map((app) => (
                <DropdownMenuItem
                  key={app.id}
                  className={app.slug === currentApp.slug ? "text-primary-ink" : ""}
                  onClick={() => {
                    void navigate({ to: "/app/$appSlug", params: { appSlug: app.slug } });
                  }}
                >
                  {app.name}
                </DropdownMenuItem>
              ))}
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

// ─── PendingOnboardingBanner ─────────────────────────────────────────────────

function PendingOnboardingBanner() {
  const applications = useRouteContext({ from: "/_blacklight/_app-shell", select: (ctx) => ctx.applications });
  const navigate = useNavigate();
  const deleteApp = useDeleteApplication();
  const [discardTarget, setDiscardTarget] = useState<{ id: string; name: string }>();

  const incompleteApps = applications.filter(
    (app) => app.onboardingState != null && app.onboardingState.step !== "completed",
  );

  if (incompleteApps.length === 0) return null;

  const singleApp = incompleteApps.length === 1 ? incompleteApps[0] : undefined;

  return (
    <>
      <div className="mb-4 flex items-center justify-between rounded-lg border border-primary/40 bg-primary/5 px-4 py-2.5">
        <span className="text-2xs text-text-secondary">
          {singleApp != null ? (
            <>
              <strong className="font-medium text-text-primary">{singleApp.name}</strong> has incomplete setup.
            </>
          ) : (
            <>
              You have <strong className="font-medium text-text-primary">{incompleteApps.length} apps</strong> with
              incomplete setup.
            </>
          )}
        </span>
        <div className="flex items-center gap-2">
          {singleApp != null ? (
            <>
              <Button
                variant="ghost"
                size="xs"
                className="font-mono text-3xs uppercase text-text-tertiary"
                onClick={() => setDiscardTarget({ id: singleApp.id, name: singleApp.name })}
              >
                Discard
              </Button>
              <Button
                variant="outline"
                size="xs"
                className="font-mono text-3xs uppercase"
                onClick={() => navigateToOnboarding(singleApp.id, singleApp.onboardingState?.step, navigate)}
              >
                Continue setup
                <ArrowRightIcon size={12} />
              </Button>
            </>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="xs" className="font-mono text-3xs uppercase">
                    View apps
                    <CaretDownIcon size={10} />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuGroupLabel className="font-mono text-3xs uppercase tracking-widest text-text-tertiary">
                    Pending setup
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
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

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

// ─── AppBreadcrumb ────────────────────────────────────────────────────────────

function AppBreadcrumb() {
  const applications = useRouteContext({ from: "/_blacklight/_app-shell", select: (ctx) => ctx.applications });
  const params = useParams({ strict: false }) as { appSlug?: string; branchName?: string };

  if (params.appSlug == null || params.branchName == null) return null;

  const app = applications.find((a) => a.slug === params.appSlug);
  if (app == null) return null;

  return (
    <div className="flex items-center gap-2">
      <AppSelector currentApp={app} />
      <span className="text-text-tertiary">/</span>
      <Suspense
        fallback={
          <span className="flex items-center gap-1.5 font-mono text-2xs text-text-tertiary">
            <GitBranchIcon size={12} />
            {params.branchName}
          </span>
        }
      >
        <BranchSelector appSlug={params.appSlug} applicationId={app.id} currentBranch={params.branchName} />
      </Suspense>
    </div>
  );
}

export { AppBreadcrumb, PendingOnboardingBanner };
