import { Button, Logo } from "@autonoma/blacklight";
import { createFileRoute } from "@tanstack/react-router";
import { SwitchOrganizationButton } from "components/organization/switch-organization-button";
import { SUPPORT_URL } from "components/talk-to-support";
import { useAuthClient } from "lib/auth";

export const Route = createFileRoute("/_blacklight/(auth)/pending")({
  component: PendingPage,
});

/**
 * Where the app shell sends a session it cannot open an organization for.
 *
 * This used to read "Your organization is pending approval. You'll be notified once access is granted", which was
 * wrong twice. Organizations default to `approved` and nothing in the signup path ever writes `pending`, so the
 * queue it described is one no real user is placed in - the case a live user actually hits is a session naming an
 * organization they are not a member of. And nothing notifies on approval either: `approveOrg` flips the status
 * and refreshes sessions, silently.
 *
 * So the copy covers the cause that actually brings people here, names the approval path as the secondary
 * possibility without promising a message, and offers a way out. Three controls, because the original had only
 * Sign out and that resolves neither cause: switching is the fix when you belong to another organization, support
 * is the only move when you are genuinely waiting on approval, and signing out is the last resort rather than the
 * first suggestion.
 */
function PendingPage() {
  const authClient = useAuthClient();

  return (
    <div className="flex h-full items-center justify-center bg-surface-void">
      <div className="flex max-w-md flex-col items-center px-6 text-center">
        <Logo variant="symbol" className="mb-8 size-12" />
        <h1 className="text-2xl font-medium text-text-primary">No organization to open</h1>
        <p className="mt-3 text-sm leading-relaxed text-text-secondary">
          You are signed in, but this account is not a member of an organization we can open. If you were removed from
          one, whoever administers it can invite you back. If you are waiting on approval for a new organization, that
          is done by hand and nothing emails you when it lands.
        </p>
        {/* This screen is a dead end for anyone whose session happens to point at the organization awaiting
            approval - and a member of a second, approved one has no other way back to it, because the bar that
            carries the switcher only renders inside the app shell this route is outside of. */}
        <div className="mt-6 flex items-center gap-2">
          <SwitchOrganizationButton />
          <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" className="block">
            <Button variant="outline">Talk to support</Button>
          </a>
          <Button
            variant="ghost"
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
