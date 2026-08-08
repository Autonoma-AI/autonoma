import { Button, Skeleton } from "@autonoma/blacklight";
import type { InvitationPreview } from "@autonoma/types";
import { UserPlusIcon } from "@phosphor-icons/react/UserPlus";
import { Link, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { currentPathForRedirect } from "lib/auth-redirect";
import { ensureSessionData } from "lib/query/auth.queries";
import {
  ensureInvitationData,
  useAcceptInvitation,
  useDeclineInvitation,
  useInvitation,
} from "lib/query/organization.queries";
import { Suspense } from "react";

/**
 * Deliberately outside `_app-shell`: that layout redirects anyone whose organization is `pending` or
 * `rejected` away to a dead end, and an invitation is exactly the escape hatch such a user needs. It
 * still requires a session - the invitation is only ever matched against the signed-in user's email -
 * so an unauthenticated visitor is bounced through login and returned here.
 */
export const Route = createFileRoute("/_blacklight/invite/$invitationId")({
  beforeLoad: async ({ context: { queryClient } }) => {
    const session = await ensureSessionData(queryClient);
    if (session == null) {
      throw redirect({
        to: "/login",
        search: { error: undefined, redirectTo: currentPathForRedirect(window.location) },
      });
    }
  },
  loader: async ({ context: { queryClient }, params: { invitationId } }) => {
    await ensureInvitationData(queryClient, invitationId);
  },
  errorComponent: () => (
    <InviteFrame
      title="This invitation isn't valid"
      body="The link may be wrong, or the invitation may have been deleted."
    >
      <HomeLink />
    </InviteFrame>
  ),
  pendingComponent: () => (
    <InviteFrame title="Checking your invitation" body="One moment.">
      <Skeleton className="h-10 w-48" />
    </InviteFrame>
  ),
  component: InvitePage,
});

function InvitePage() {
  const { invitationId } = Route.useParams();

  return (
    <Suspense
      fallback={
        <InviteFrame title="Checking your invitation" body="One moment.">
          <Skeleton className="h-10 w-48" />
        </InviteFrame>
      }
    >
      <InviteContent invitationId={invitationId} />
    </Suspense>
  );
}

function InviteContent({ invitationId }: { invitationId: string }) {
  const { data: invitation } = useInvitation(invitationId);

  if (invitation.outcome === "joinable") return <JoinableInvite invitation={invitation} />;
  return <ClosedInvite invitation={invitation} />;
}

function JoinableInvite({ invitation }: { invitation: InvitationPreview }) {
  const navigate = useNavigate();
  const acceptInvitation = useAcceptInvitation();
  const declineInvitation = useDeclineInvitation();
  const isBusy = acceptInvitation.isPending || declineInvitation.isPending;

  function handleAccept() {
    acceptInvitation.mutate(
      { invitationId: invitation.invitationId },
      {
        // The whole cache was answered for the org they just left, so land on the app hub and let it
        // re-resolve rather than returning to a page scoped to an application they can no longer see.
        onSuccess: () => void navigate({ to: "/" }),
      },
    );
  }

  return (
    <InviteFrame
      title={`Join ${invitation.organizationName}`}
      body={`${invitation.inviterName} invited ${invitation.invitedEmail} to their Autonoma organization.`}
    >
      <p className="text-xs text-text-secondary">
        Joining adds {invitation.organizationName} to your account. You keep any organizations you're already in, and
        can switch between them from the sidebar.
      </p>

      <div className="flex w-full items-center justify-center gap-3">
        <Button
          variant="outline"
          disabled={isBusy}
          onClick={() => declineInvitation.mutate({ invitationId: invitation.invitationId })}
        >
          Decline
        </Button>
        <Button variant="accent" disabled={isBusy} onClick={handleAccept}>
          {acceptInvitation.isPending ? "Joining..." : `Join ${invitation.organizationName}`}
        </Button>
      </div>
    </InviteFrame>
  );
}

const CLOSED_COPY: Record<Exclude<InvitationPreview["outcome"], "joinable">, { title: string; body: string }> = {
  "wrong-account": {
    title: "This invitation is for a different account",
    body: "Sign out and sign back in with the invited address to accept it.",
  },
  "already-member": {
    title: "You're already a member",
    body: "Nothing to do - this organization is already yours.",
  },
  expired: {
    title: "This invitation has expired",
    body: "Ask whoever invited you to send a new one.",
  },
  revoked: {
    title: "This invitation was revoked",
    body: "Ask whoever invited you to send a new one.",
  },
  accepted: {
    title: "This invitation was already used",
    body: "It can only be accepted once.",
  },
  declined: {
    title: "This invitation was declined",
    body: "Ask whoever invited you to send a new one if that was a mistake.",
  },
};

function ClosedInvite({ invitation }: { invitation: InvitationPreview }) {
  if (invitation.outcome === "joinable") return null;
  const copy = CLOSED_COPY[invitation.outcome];

  return (
    <InviteFrame title={copy.title} body={copy.body}>
      {invitation.outcome === "wrong-account" && (
        <p className="font-mono text-xs text-text-secondary">Invited: {invitation.invitedEmail}</p>
      )}
      <HomeLink />
    </InviteFrame>
  );
}

function HomeLink() {
  return (
    <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
      Go to Autonoma
    </Link>
  );
}

function InviteFrame({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-surface-void">
      <div className="flex w-full max-w-md flex-col items-center gap-5 px-6 text-center">
        <div className="flex size-12 items-center justify-center border border-border-mid bg-surface-base">
          <UserPlusIcon size={22} className="text-primary" />
        </div>
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-2xl font-medium text-text-primary">{title}</h1>
          <p className="font-mono text-sm text-text-secondary">{body}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
