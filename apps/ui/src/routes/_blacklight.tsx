import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  useToastManager,
} from "@autonoma/blacklight";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { toastManager } from "lib/toast-manager";

export const Route = createFileRoute("/_blacklight")({
  component: BlacklightLayout,
});

function BlacklightLayout() {
  return (
    <ToastProvider toastManager={toastManager} timeout={2500} limit={3}>
      <ThemedShell />
      <GlobalToasts />
    </ToastProvider>
  );
}

function ThemedShell() {
  return (
    <div className="blacklight h-dvh">
      <Outlet />
    </div>
  );
}

function GlobalToasts() {
  const { toasts } = useToastManager();

  return (
    <ToastViewport>
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast}>
          <ToastTitle>{toast.title}</ToastTitle>
          {toast.description != null && <ToastDescription>{toast.description}</ToastDescription>}
          <ToastClose />
        </Toast>
      ))}
    </ToastViewport>
  );
}
