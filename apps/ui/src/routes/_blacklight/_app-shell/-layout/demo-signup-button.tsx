import { Button } from "@autonoma/blacklight";
import { useAuthClient } from "lib/auth";
import { absoluteRedirectUrl } from "lib/auth-redirect";
import { toastManager } from "lib/toast-manager";
import { useState } from "react";

/**
 * The demo's conversion action: start a real Google signup. Redirects straight to
 * Google (skipping the /login page) and deliberately does NOT sign out the demo session
 * first - so Back from Google returns to the still-live demo, and abandoning the signup
 * leaves the visitor exactly where they were. On success better-auth replaces the shared
 * demo session with the new user's; account linking is off and the demo's `.invalid`
 * email can never match a real Google email, so nothing attaches to the demo account.
 */
export function DemoSignupButton({ label = "Sign up free" }: { label?: string }) {
  const authClient = useAuthClient();
  const [isPending, setIsPending] = useState(false);

  const startSignup = async () => {
    setIsPending(true);
    try {
      await authClient.signIn.social({
        provider: "google",
        callbackURL: absoluteRedirectUrl(window.location.origin, undefined),
        errorCallbackURL: `${window.location.origin}/login`,
      });
    } catch {
      setIsPending(false);
      toastManager.add({
        type: "critical",
        title: "Sign up failed",
        description: "Something went wrong. Please try again.",
      });
    }
  };

  return (
    <Button size="xs" variant="accent" onClick={() => void startSignup()} disabled={isPending}>
      {label}
    </Button>
  );
}
