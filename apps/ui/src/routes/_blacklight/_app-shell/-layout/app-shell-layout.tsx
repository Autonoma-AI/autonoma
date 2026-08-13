import {
  cn,
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  TooltipProvider,
  useToastManager,
} from "@autonoma/blacklight";
import { toastManager } from "lib/toast-manager";
import { type ReactNode, useState } from "react";
import { APP_SHELL_GUTTER } from "./app-shell-gutter";
import { DemoBanner } from "./demo-banner";
import { DemoModal } from "./demo-modal";
import { FeedbackModal } from "./feedback-modal";
import { MinimalTopNav } from "./minimal-top-nav";
import { TopNav } from "./top-nav";
import { useAppNav } from "./use-app-nav";

/**
 * Where toasts start, measured from the top of the viewport.
 *
 * `ToastViewport` is `fixed top-4`, which was written when the application pages had no bar above them - a rail
 * took the width instead. With chrome across the top, that lands a 384px panel squarely over the account menu
 * and the application switcher. This clears it: the bar (`h-14`, 56px) plus the same 16px gap the original had.
 */
const TOAST_TOP = "top-18";

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

function AppShellToasts() {
  const { toasts } = useToastManager();
  return (
    <ToastViewport className={TOAST_TOP}>
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
  const { scope } = useAppNav();
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const showAppNav = scope !== "none";

  // The two bars share the shell, so the page below them starts at the same place either way. Only the padding
  // differs: the pages that render without the app nav (organization settings, the app picker) lay out their
  // own margins, and a padded `main` would double them.
  return (
    <ToastProvider toastManager={toastManager}>
      <TooltipProvider>
        <div className="relative flex h-full flex-col overflow-hidden bg-surface-void">
          <GridBackground />

          {showAppNav ? (
            <TopNav onFeedback={() => setFeedbackOpen(true)} />
          ) : (
            <MinimalTopNav onFeedback={() => setFeedbackOpen(true)} />
          )}

          <DemoBanner />

          <main className="relative z-10 flex-1 overflow-y-auto">
            {/* Only the pages that render with the app nav get the shell's padding. The ones that do not
                (finish setup, organization settings) lay out their own margins, and padding here would
                double them.

                `h-full` is load-bearing, not decoration: a page that fills the viewport does it by resolving a
                percentage height against this wrapper, so leaving it auto-height silently turns
                `h-[calc(100%+3rem)]` into "as tall as the content" and the page's own scroll regions stop
                scrolling. Padding is inside the height because the box is border-box. */}
            <div className={showAppNav ? cn("h-full", APP_SHELL_GUTTER.content, APP_SHELL_GUTTER.container) : "h-full"}>
              {children}
            </div>
          </main>
        </div>
        <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />
        <AppShellToasts />
        <DemoModal />
      </TooltipProvider>
    </ToastProvider>
  );
}
