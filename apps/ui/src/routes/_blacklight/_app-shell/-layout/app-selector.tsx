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
} from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CaretUpDownIcon } from "@phosphor-icons/react/CaretUpDown";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useNavigate, useParams, useRouteContext } from "@tanstack/react-router";
import { isMidOnboarding } from "lib/onboarding/app-onboarding";
import { navigateToOnboarding } from "lib/onboarding/navigate-to-onboarding";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useDeleteApplication } from "lib/query/app-shell.queries";
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

function AppSelector({
  currentApp,
  organizationName,
}: {
  currentApp: { slug: string; name: string };
  organizationName: string;
}) {
  const applications = useRouteContext({ from: "/_blacklight/_app-shell", select: (ctx) => ctx.applications });
  const navigate = useNavigate();
  const deleteApp = useDeleteApplication();
  const [discardTarget, setDiscardTarget] = useState<{ id: string; name: string }>();

  const incompleteApps = applications.filter(isMidOnboarding);
  const completedApps = applications.filter((app) => !isMidOnboarding(app));

  // The organization reads as a path prefix rather than a second label, and below `lg` it is the part that goes:
  // on a narrow bar the application you are actually looking at survives and its owner gives way.
  //
  // The cap is a backstop for a pathological name, not the working width. At 224px it was the binding constraint
  // on every screen size - the bar had hundreds of pixels of slack beside it and the trigger still clipped the
  // organization to four characters - so ordinary names now fit and `min-w-0` lets flex take the width back when
  // the row genuinely runs out.
  const trigger = (
    <DropdownMenuTrigger
      aria-label={`Switch application (current: ${currentApp.name})`}
      className="flex h-full min-w-0 max-w-md items-center gap-2 px-2 text-sm transition-colors hover:bg-surface-raised"
    >
      <span className="block size-2 shrink-0 rounded-sm bg-primary" />
      <span className="hidden min-w-0 truncate text-text-secondary lg:block">{organizationName} /</span>
      <span className="min-w-0 truncate font-medium text-text-primary">{currentApp.name}</span>
      <CaretUpDownIcon size={12} className="shrink-0 text-text-secondary" />
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
              void navigate({ to: "/onboarding", search: buildOnboardingSearch("add-app") });
            }}
          >
            <PlusIcon size={14} weight="bold" />
            Add app
          </DropdownMenuItem>

          {incompleteApps.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuGroupLabel className="font-mono text-3xs uppercase tracking-widest text-text-secondary">
                  Continue setup
                </DropdownMenuGroupLabel>
                {incompleteApps.map((app) => (
                  <DropdownMenuItem
                    key={app.id}
                    className="text-text-secondary opacity-60 hover:opacity-100"
                    onClick={() => {
                      navigateToOnboarding(app.id, app.onboardingState?.step, navigate);
                    }}
                  >
                    <span className="truncate">{app.name}</span>
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        className="rounded p-0.5 text-text-secondary hover:text-status-critical"
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
                        void navigate({ to: "/app/$appSlug/settings", params: { appSlug: app.slug } });
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

export function AppSwitcher() {
  const applications = useRouteContext({ from: "/_blacklight/_app-shell", select: (ctx) => ctx.applications });
  const activeOrganization = useRouteContext({
    from: "/_blacklight/_app-shell",
    select: (ctx) => ctx.activeOrganization,
  });
  const params = useParams({ strict: false });

  if (params.appSlug == null) return undefined;

  const app = applications.find((a) => a.slug === params.appSlug);
  if (app == null) return undefined;

  return <AppSelector currentApp={app} organizationName={activeOrganization.name} />;
}
