import { Badge, BrailleSpinner, Button } from "@autonoma/blacklight";
import { createFileRoute } from "@tanstack/react-router";
import { Google } from "components/icons/google";
import { useAuthClient } from "lib/auth";
import { toastManager } from "lib/toast-manager";
import * as React from "react";

export const Route = createFileRoute("/_blacklight/(auth)/login/")({
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>): { error?: string } => {
    if (typeof search.error === "string") return { error: search.error };
    return {};
  },
});

function useGoogleSignIn() {
  const authClient = useAuthClient();
  const [isPending, setIsPending] = React.useState(false);

  const signIn = async () => {
    setIsPending(true);
    try {
      await authClient.signIn.social({
        provider: "google",
        callbackURL: window.location.origin,
        errorCallbackURL: `${window.location.origin}/login`,
      });
    } catch {
      setIsPending(false);
      toastManager.add({
        type: "critical",
        title: "Sign in failed",
        description: "Something went wrong. Please try again.",
      });
    }
  };

  return { signIn, isPending };
}

function useDotSpotlight() {
  const rafRef = React.useRef<number | undefined>(undefined);

  const setSpotlightPosition = (element: HTMLDivElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      element.style.setProperty("--mx", `${x}px`);
      element.style.setProperty("--my", `${y}px`);
    });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    setSpotlightPosition(event.currentTarget, event.clientX, event.clientY);
  };

  const onPointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      element.style.setProperty("--mx", "50%");
      element.style.setProperty("--my", "50%");
    });
  };

  React.useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return { onPointerMove, onPointerLeave };
}

function useErrorFromSearch() {
  const { error } = Route.useSearch();
  const navigate = Route.useNavigate();

  React.useEffect(() => {
    if (error == null) return;

    toastManager.add({
      type: "critical",
      title: "Sign in failed",
      description: "Something went wrong. Please try again.",
    });

    void navigate({ search: { error: undefined }, replace: true });
  }, [error, navigate]);
}

function LoginPage() {
  const { signIn, isPending } = useGoogleSignIn();
  const dotSpotlight = useDotSpotlight();
  useErrorFromSearch();

  return (
    <div
      className="relative flex h-full items-center justify-center overflow-hidden bg-surface-void"
      onPointerMove={dotSpotlight.onPointerMove}
      onPointerLeave={dotSpotlight.onPointerLeave}
      style={{ "--mx": "50%", "--my": "50%" } as React.CSSProperties}
    >
      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{
          backgroundSize: "24px 24px",
          backgroundImage: "radial-gradient(circle at center, rgba(255, 255, 255, 0.10) 1px, transparent 1px)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 z-20"
        style={{
          backgroundSize: "24px 24px",
          backgroundImage: "radial-gradient(circle at center, rgba(255, 255, 255, 0.35) 1px, transparent 1px)",
          WebkitMaskImage:
            "radial-gradient(180px circle at var(--mx, 50%) var(--my, 50%), rgba(0, 0, 0, 1), rgba(0, 0, 0, 0))",
          maskImage:
            "radial-gradient(180px circle at var(--mx, 50%) var(--my, 50%), rgba(0, 0, 0, 1), rgba(0, 0, 0, 0))",
        }}
      />

      <div className="relative z-30 flex w-full max-w-md flex-col items-center px-6">
        <h1 className="text-center text-3xl font-medium tracking-tight text-text-primary">
          Set up your AI testing agent
        </h1>
        <p className="mt-3 text-center font-mono text-sm text-text-secondary">
          Sign in to connect your app and let AI agents automatically find bugs - no test scripts required.
        </p>

        <Button variant="outline" size="lg" className="mt-8 w-full gap-3" onClick={signIn} disabled={isPending}>
          {isPending ? <BrailleSpinner animation="braille" size="sm" /> : <Google />}
          <span>{isPending ? "Signing in..." : "Continue with Google"}</span>
        </Button>

        <div className="mt-8 flex flex-wrap justify-center gap-2">
          {["AI-powered", "Zero scripts", "Self-healing"].map((item) => (
            <Badge key={item} variant="outline" className="font-mono text-3xs uppercase tracking-wider">
              {item}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}
