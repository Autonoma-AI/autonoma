import { createFileRoute } from "@tanstack/react-router";
import { EmailPasswordForm } from "./-components/email-password-form";

/**
 * Unlinked on purpose - not reachable from the normal /login page. Only for
 * accounts on the server's TEST_ACCOUNT_ALLOWED_EMAILS allowlist (e.g. a
 * marketplace reviewer); the server rejects anyone else with 403. Real users
 * are expected to sign in with Google only.
 */
export const Route = createFileRoute("/_blacklight/(auth)/login/test-account")({
  component: TestAccountLoginPage,
});

function TestAccountLoginPage() {
  return (
    <div className="flex h-full items-center justify-center bg-surface-void px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-xl font-medium text-text-primary">Test account sign-in</h1>
        <p className="mt-2 text-center font-mono text-sm text-text-secondary">
          Password sign-in for allow-listed test accounts only.
        </p>
        <div className="mt-6">
          <EmailPasswordForm />
        </div>
      </div>
    </div>
  );
}
