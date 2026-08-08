import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Skeleton,
} from "@autonoma/blacklight";
import { ClipboardTextIcon } from "@phosphor-icons/react/ClipboardText";
import { EnvelopeIcon } from "@phosphor-icons/react/Envelope";
import { UserMinusIcon } from "@phosphor-icons/react/UserMinus";
import { UserPlusIcon } from "@phosphor-icons/react/UserPlus";
import {
  useInviteMember,
  useOrganizationInvitations,
  useOrganizationMembers,
  useRemoveMember,
  useRevokeInvitation,
} from "lib/query/organization.queries";
import { Suspense, useState } from "react";

/**
 * Members and pending invitations for the active organization.
 *
 * Shown for every organization. Inviting an address that would auto-join by email domain anyway is
 * refused by the server with an error saying so - which is better than hiding the page, since the
 * page is also where `Leave` lives.
 */
export function MembersPanel() {
  const [inviteOpen, setInviteOpen] = useState(false);

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader className="flex items-center justify-between">
          <PanelTitle>Members</PanelTitle>
          <Button variant="accent" className="gap-1.5" onClick={() => setInviteOpen(true)}>
            <UserPlusIcon size={14} weight="bold" />
            Invite member
          </Button>
        </PanelHeader>
        <PanelBody>
          <p className="mb-4 text-xs text-text-secondary">
            Everyone here can see and change every application in this organization.
          </p>
          <Suspense fallback={<MembersListSkeleton />}>
            <MembersList />
          </Suspense>
        </PanelBody>
      </Panel>

      <Suspense fallback={null}>
        <PendingInvitationsPanel />
      </Suspense>

      <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}

function MembersList() {
  const { data: members } = useOrganizationMembers();

  return (
    <div className="divide-y divide-border-dim">
      {members.map((member) => (
        <MemberRow key={member.userId} member={member} canRemove={members.length > 1} />
      ))}
    </div>
  );
}

function MembersListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 2 }, (_, index) => (
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  );
}

interface MemberRowProps {
  member: {
    userId: string;
    name: string;
    email: string;
    joinedAt: Date;
    isSelf: boolean;
  };
  canRemove: boolean;
}

function MemberRow({ member, canRemove }: MemberRowProps) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const displayName = member.name.length > 0 ? member.name : member.email;

  return (
    <div className="flex items-center justify-between px-1 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-text-primary">
          {displayName}
          {member.isSelf && <span className="ml-2 font-mono text-3xs text-text-secondary">You</span>}
        </span>
        <div className="flex items-center gap-3 font-mono text-3xs text-text-secondary">
          <span>{member.email}</span>
          <span>Joined {new Date(member.joinedAt).toLocaleDateString()}</span>
        </div>
      </div>
      {/* Nobody can remove themselves - leaving would strand an org that may hold the only copy
          of its applications, and the server refuses it too. */}
      {!member.isSelf && canRemove && (
        <button
          type="button"
          onClick={() => setRemoveOpen(true)}
          className="text-text-secondary transition-colors hover:text-status-critical"
          aria-label={`Remove ${displayName}`}
        >
          <UserMinusIcon size={16} />
        </button>
      )}
      <RemoveMemberDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        userId={member.userId}
        displayName={displayName}
      />
    </div>
  );
}

function RemoveMemberDialog({
  open,
  onOpenChange,
  userId,
  displayName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  displayName: string;
}) {
  const removeMember = useRemoveMember();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove member</DialogTitle>
          <DialogDescription>
            <strong>{displayName}</strong> will lose access to every application in this organization. They keep their
            Autonoma account and can be invited back.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            disabled={removeMember.isPending}
            onClick={() => removeMember.mutate({ userId }, { onSuccess: () => onOpenChange(false) })}
          >
            {removeMember.isPending ? "Removing..." : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PendingInvitationsPanel() {
  const { data: invitations } = useOrganizationInvitations();

  if (invitations.length === 0) return null;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Pending invitations</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <div className="divide-y divide-border-dim">
          {invitations.map((invitation) => (
            <InvitationRow key={invitation.id} invitation={invitation} />
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}

interface InvitationRowProps {
  invitation: {
    id: string;
    email: string;
    inviterName: string;
    expiresAt: Date;
    acceptUrl: string;
  };
}

function InvitationRow({ invitation }: InvitationRowProps) {
  const revokeInvitation = useRevokeInvitation();
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(invitation.acceptUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-center justify-between gap-3 px-1 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 truncate text-sm font-medium text-text-primary">
          <EnvelopeIcon size={14} className="shrink-0 text-text-secondary" />
          {invitation.email}
        </span>
        <div className="flex items-center gap-3 font-mono text-3xs text-text-secondary">
          <span>Invited by {invitation.inviterName}</span>
          <span>Expires {new Date(invitation.expiresAt).toLocaleDateString()}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* The link is worth exposing because email is the one part of this that can silently
            fail - a bounced or filtered invitation is otherwise indistinguishable from one nobody
            has got round to accepting. */}
        <Button variant="outline" size="sm" className="gap-1.5" onClick={handleCopy}>
          <ClipboardTextIcon size={14} />
          {copied ? "Copied" : "Copy link"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={revokeInvitation.isPending}
          onClick={() => revokeInvitation.mutate({ invitationId: invitation.id })}
        >
          Revoke
        </Button>
      </div>
    </div>
  );
}

function InviteMemberDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [email, setEmail] = useState("");
  const inviteMember = useInviteMember();
  const trimmedEmail = email.trim();

  function handleInvite() {
    if (trimmedEmail.length === 0) return;
    inviteMember.mutate(
      { email: trimmedEmail },
      {
        onSuccess: () => {
          setEmail("");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            We'll email them a link to join this organization. The invitation expires in 7 days.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-email" className="font-mono text-2xs uppercase tracking-widest text-text-secondary">
              Email
            </Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="teammate@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleInvite();
              }}
            />
          </div>
          <p className="mt-3 text-xs text-text-secondary">
            If they already use Autonoma, this is added to their account - they keep the organizations they're already
            in and can switch between them.
          </p>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={handleInvite} disabled={trimmedEmail.length === 0 || inviteMember.isPending}>
            {inviteMember.isPending ? "Sending..." : "Send invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
