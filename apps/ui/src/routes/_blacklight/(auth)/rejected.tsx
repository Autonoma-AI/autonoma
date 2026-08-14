import { Button, Logo } from "@autonoma/blacklight";
import { createFileRoute } from "@tanstack/react-router";
import { SwitchOrganizationButton } from "components/organization/switch-organization-button";
import { useAuthClient } from "lib/auth";

export const Route = createFileRoute("/_blacklight/(auth)/rejected")({
  component: RejectedPage,
});

function RejectedPage() {
  const authClient = useAuthClient();

  return (
    <div className="flex h-full items-center justify-center bg-surface-void">
      <div className="flex max-w-md flex-col items-center px-6 text-center">
        <Logo variant="symbol" className="mb-8 size-12" />
        <h1 className="text-2xl font-medium text-status-critical">Access Denied</h1>
        <p className="mt-3 font-mono text-sm text-text-secondary">
          Your organization access request has been rejected. Contact support for assistance.
        </p>
        {/* A rejected organization is not necessarily the reader's only one - see `pending.tsx`. */}
        <div className="mt-6 flex items-center gap-2">
          <SwitchOrganizationButton />
          <Button
            variant="outline"
            onClick={() => {
              void authClient.signOut();
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
