import { BrailleSpinner, Button, Input } from "@autonoma/blacklight";
import { getApiOrigin } from "lib/api-origin";
import { toastManager } from "lib/toast-manager";
import * as React from "react";

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

      // getApiOrigin(), not a same-origin relative path or env.VITE_API_URL -
      // see its doc comment: the app origin sits behind CloudFront, whose WAF
      // can mangle a sign-in/sign-up payload (e.g. a password with characters
      // that trip injection rules).
      const res = await fetch(`${getApiOrigin()}${path}`, {
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

/** Email/password sign-in form. Used on previewkit-deployed hostnames and on the hidden test-account route - never on the main /login page. */
export function EmailPasswordForm() {
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
