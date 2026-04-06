import { Button } from "@autonoma/blacklight";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { SignOutIcon } from "@phosphor-icons/react/SignOut";
import { Outlet, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { TalkToSupport } from "components/talk-to-support";
import { useAuth, useAuthClient } from "lib/auth";
import { ensureSessionData } from "lib/query/auth.queries";
import { useState } from "react";
import { StepProgress } from "./-components/step-progress";

export const Route = createFileRoute("/_blacklight/onboarding")({
  component: OnboardingLayout,
  beforeLoad: async ({ context: { queryClient } }) => {
    const session = await ensureSessionData(queryClient);
    if (session == null) throw Route.redirect({ to: "/login", search: { error: undefined } });
  },
});

function getCurrentStep(pathname: string) {
  if (pathname.includes("/install")) return 0;
  if (pathname.includes("/configure")) return 1;
  if (pathname.includes("/working")) return 2;
  if (pathname.includes("/scenario-dry-run")) return 3;
  if (pathname.includes("/url")) return 4;
  return 0;
}

function GridBackground() {
  return (
    <div
      className="pointer-events-none absolute inset-0 opacity-5"
      style={{
        backgroundImage:
          "linear-gradient(var(--border-dim) 1px, transparent 1px), linear-gradient(90deg, var(--border-dim) 1px, transparent 1px)",
        backgroundSize: "60px 60px",
      }}
    />
  );
}

function OnboardingLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const authClient = useAuthClient();
  const currentStep = getCurrentStep(location.pathname);
  const [confirmReset, setConfirmReset] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  function handleReset() {
    setIsResetting(true);
    localStorage.removeItem("autonoma.onboarding.apiKey");
    localStorage.removeItem("autonoma.onboarding.applicationId");
    void navigate({ to: "/onboarding/install" });
    setConfirmReset(false);
    setIsResetting(false);
  }

  return (
    <div className="relative flex h-full overflow-hidden bg-surface-void">
      <GridBackground />

      {/* Top nav */}
      <div className="fixed left-0 right-0 top-0 z-50 flex h-14 shrink-0 items-center justify-between border-b border-border-dim bg-surface-void/80 px-6 backdrop-blur">
        <img
          src="/logo.svg"
          alt="Autonoma"
          className="h-5 [.blacklight-dark_&]:brightness-0 [.blacklight-dark_&]:invert"
        />
        <div className="flex items-center gap-2">
          <span className="font-mono text-2xs text-text-tertiary">{user?.name ?? user?.email ?? ""}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Sign out"
            className="hover:text-status-critical"
            onClick={() => {
              void authClient.signOut().then(() => {
                window.location.href = "/login";
              });
            }}
          >
            <SignOutIcon size={16} />
          </Button>
        </div>
      </div>

      {/* Sidebar */}
      <aside className="relative z-10 mt-14 flex w-64 shrink-0 flex-col border-r border-border-dim bg-surface-base/30 backdrop-blur-sm">
        <div className="flex-1 p-8 pt-10">
          <h3 className="mb-8 font-mono text-3xs uppercase tracking-widest text-text-tertiary">New Application</h3>
          <StepProgress currentStep={currentStep} />
        </div>

        <div className="border-t border-border-dim px-8 py-6">
          <TalkToSupport />
        </div>

        {/* Reset section */}
        <div className="border-t border-border-dim p-6">
          {confirmReset ? (
            <div className="space-y-3">
              <p className="font-mono text-2xs text-text-tertiary">Restart onboarding from scratch?</p>
              <div className="flex gap-2">
                <Button variant="destructive" size="xs" onClick={handleReset} disabled={isResetting}>
                  {isResetting ? "resetting..." : "confirm reset"}
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setConfirmReset(false)}>
                  cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="xs"
              className="gap-2 font-mono text-3xs uppercase tracking-widest opacity-50 hover:opacity-100"
              onClick={() => setConfirmReset(true)}
            >
              <ArrowCounterClockwiseIcon size={12} />
              reset onboarding
            </Button>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main
        className="relative z-10 mt-14 flex-1 overflow-y-auto"
        style={{
          backgroundSize: "24px 24px",
          backgroundImage: "radial-gradient(circle at center, rgba(255, 255, 255, 0.03) 1px, transparent 1px)",
        }}
      >
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col justify-center">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
