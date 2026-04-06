import {
  Button,
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  TooltipProvider,
  useToastManager,
} from "@autonoma/blacklight";
import { SignOutIcon } from "@phosphor-icons/react/SignOut";
import { Link, useLocation } from "@tanstack/react-router";
import { useAuth, useAuthClient } from "lib/auth";
import { toastManager } from "lib/toast-manager";
import type { ReactNode } from "react";
import { openFeedbackSurvey } from "./feedback-survey";
import { Sidebar, useBranchNav, useSidebarCollapsed } from "./sidebar";
import { AppBreadcrumb, PendingOnboardingBanner } from "./top-bar";

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

function MinimalLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const authClient = useAuthClient();

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-surface-void">
      <GridBackground />

      <div className="relative z-10 flex h-14 shrink-0 items-center justify-between border-b border-border-dim bg-surface-void/80 px-6 backdrop-blur">
        <Link to="/">
          <img
            src="/logo.svg"
            alt="Autonoma"
            className="h-5 [.blacklight-dark_&]:brightness-0 [.blacklight-dark_&]:invert"
          />
        </Link>
        <div className="flex items-center gap-2">
          <span className="font-mono text-2xs text-text-tertiary">{user?.name ?? user?.email ?? "User"}</span>
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

      <div className="relative z-10 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function AppShellToasts() {
  const { toasts } = useToastManager();
  return (
    <ToastViewport>
      {toasts.map((t) => (
        <Toast key={t.id} toast={t}>
          <ToastTitle>{t.title}</ToastTitle>
          {t.description != null && <ToastDescription>{t.description}</ToastDescription>}
          <ToastClose />
        </Toast>
      ))}
    </ToastViewport>
  );
}

export function AppShellLayout({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  const { pathname } = useLocation();
  const { items: branchNavItems } = useBranchNav();
  const isAdminPage = pathname === "/admin" || pathname.startsWith("/admin/");
  const [collapsed, setCollapsed] = useSidebarCollapsed();

  const hasBranchNav = branchNavItems.length > 0;
  const hasNav = hasBranchNav || (isAdminPage && isAdmin);

  if (!hasNav) {
    return (
      <ToastProvider toastManager={toastManager}>
        <MinimalLayout>{children}</MinimalLayout>
        <AppShellToasts />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider toastManager={toastManager}>
      <TooltipProvider>
        <div
          className="grid h-full overflow-hidden transition-[grid-template-columns] duration-200"
          style={{ gridTemplateColumns: collapsed ? "60px 1fr" : "200px 1fr" }}
        >
          <Sidebar
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed(!collapsed)}
            onFeedback={openFeedbackSurvey}
          />

          <main className="relative flex flex-col overflow-hidden bg-surface-void">
            <GridBackground />

            <div className="relative z-10 flex shrink-0 flex-col">
              <div className="flex items-center justify-center gap-2 bg-primary px-4 py-1.5 text-2xs font-medium text-primary-foreground">
                <span>You're using an early version of Autonoma.</span>
                <button
                  type="button"
                  onClick={openFeedbackSurvey}
                  className="cursor-pointer underline underline-offset-2 hover:opacity-80"
                >
                  Share your feedback
                </button>
              </div>
              <div className="flex h-14 items-center border-b border-border-dim bg-surface-void/80 px-6 backdrop-blur">
                <div className="flex items-center gap-3">
                  <AppBreadcrumb />
                </div>
              </div>
            </div>

            <div className="relative z-10 flex-1 overflow-y-auto p-6">
              <PendingOnboardingBanner />
              {children}
            </div>
          </main>
        </div>
        <AppShellToasts />
      </TooltipProvider>
    </ToastProvider>
  );
}
