import { Badge, BrailleSpinner, Button, Input } from "@autonoma/blacklight";
import { createFileRoute } from "@tanstack/react-router";
import { Google } from "components/icons/google";
import { env } from "env";
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

function useIsPreviewEnvironment() {
  return window.location.hostname.endsWith(`.preview.${env.VITE_INTERNAL_DOMAIN}`);
}

type EmailAuthMode = "signin" | "signup";

function useEmailAuth() {
  const [isPending, setIsPending] = React.useState(false);
  const [mode, setMode] = React.useState<EmailAuthMode>("signin");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsPending(true);
    try {
      const path = mode === "signin" ? "/v1/auth/sign-in/email" : "/v1/auth/sign-up/email";
      const body = mode === "signin" ? { email, password } : { email, password, name: email };

      const res = await fetch(`${env.VITE_API_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });

      const data = (await res.json()) as { error?: { message?: string } };

      if (!res.ok) {
        throw new Error(data.error?.message ?? "Authentication failed");
      }

      window.location.replace(window.location.origin);
    } catch (err) {
      setIsPending(false);
      toastManager.add({
        type: "critical",
        title: mode === "signin" ? "Sign in failed" : "Sign up failed",
        description: err instanceof Error ? err.message : "Something went wrong. Please try again.",
      });
    }
  };

  return { submit, isPending, mode, setMode, email, setEmail, password, setPassword };
}

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

function PreviewLoginForm() {
  const { submit, isPending, mode, setMode, email, setEmail, password, setPassword } = useEmailAuth();
  const isSignUp = mode === "signup";

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-3">
      <Input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={isPending}
        required
      />
      <Input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={isPending}
        required
      />
      <Button type="submit" variant="outline" size="lg" className="w-full gap-2" disabled={isPending}>
        {isPending && <BrailleSpinner animation="braille" size="sm" />}
        <span>{isPending ? "..." : isSignUp ? "Sign up" : "Sign in"}</span>
      </Button>
      <button
        type="button"
        className="text-center font-mono text-xs text-text-tertiary underline-offset-2 hover:underline"
        onClick={() => setMode(isSignUp ? "signin" : "signup")}
      >
        {isSignUp ? "Already have an account? Sign in" : "No account? Sign up"}
      </button>
    </form>
  );
}

function LoginPage() {
  const { signIn, isPending } = useGoogleSignIn();
  const dotSpotlight = useDotSpotlight();
  const isPreview = useIsPreviewEnvironment();
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

        <div className="mt-8 w-full">
          {isPreview ? (
            <PreviewLoginForm />
          ) : (
            <Button variant="outline" size="lg" className="w-full gap-3" onClick={signIn} disabled={isPending}>
              {isPending ? <BrailleSpinner animation="braille" size="sm" /> : <Google />}
              <span>{isPending ? "Signing in..." : "Continue with Google"}</span>
            </Button>
          )}
        </div>

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
