import {
  Badge,
  Button,
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogBody,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@autonoma/blacklight";
import { Input, Label } from "@autonoma/blacklight";
import type { MyOrganization } from "@autonoma/types";
import {
  useLeaveOrganization,
  useMyOrganizations,
  useRenameOrganization,
  useSwitchOrganization,
} from "lib/query/organization.queries";
import { useState } from "react";

/** Why leaving is refused, in the words the person reading it needs. */
const LEAVE_BLOCKED_COPY: Record<NonNullable<MyOrganization["leaveBlockedReason"]>, string> = {
  "last-organization": "This is your only organization. Join another one before leaving this one.",
  "last-member": "You're the last member. Invite someone else first, or nobody could reach its applications.",
};

/**
 * The organizations this account belongs to, with the one the session is acting as marked. Sits
 * beside the members list because both answer "who can reach what" - one for this organization, one
 * for this account.
 */
export function YourOrganizationsPanel() {
  const { data: organizations } = useMyOrganizations();

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Your organizations</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <p className="mb-4 text-xs text-text-secondary">
          Whichever you switch to is remembered, so signing in again brings you back to it.
        </p>
        <div className="divide-y divide-border-dim">
          {organizations.map((organization) => (
            <OrganizationRow key={organization.id} organization={organization} />
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}

export function YourOrganizationsPanelSkeleton() {
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Your organizations</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} className="h-11 w-full" />
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}

function OrganizationRow({ organization }: { organization: MyOrganization }) {
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const switchOrganization = useSwitchOrganization();
  const blockedReason = organization.leaveBlockedReason;

  return (
    <div className="flex items-center justify-between gap-3 px-1 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 truncate text-sm font-medium text-text-primary">
          {organization.name}
          {organization.isActive && <Badge variant="outline">Current</Badge>}
        </span>
        <div className="flex items-center gap-3 font-mono text-3xs text-text-secondary">
          <span>{organization.memberCount === 1 ? "1 member" : `${organization.memberCount} members`}</span>
          <span>
            {organization.applicationCount === 1 ? "1 application" : `${organization.applicationCount} applications`}
          </span>
          <span>Joined {new Date(organization.joinedAt).toLocaleDateString()}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {organization.isActive && (
          <Button variant="outline" size="sm" onClick={() => setRenameOpen(true)}>
            Rename
          </Button>
        )}
        {!organization.isActive && (
          <Button
            variant="outline"
            size="sm"
            disabled={switchOrganization.isPending}
            onClick={() => switchOrganization.mutate({ organizationId: organization.id })}
          >
            Switch to
          </Button>
        )}
        <LeaveButton blockedReason={blockedReason} onClick={() => setLeaveOpen(true)} />
      </div>

      <RenameOrganizationDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        organizationId={organization.id}
        currentName={organization.name}
      />

      <LeaveOrganizationDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        organizationId={organization.id}
        organizationName={organization.name}
        applicationCount={organization.applicationCount}
      />
    </div>
  );
}

/**
 * Disabled rather than hidden when leaving is refused, with the reason on hover - the question
 * "why can't I leave this one?" is the whole reason the server distinguishes the two cases.
 */
function LeaveButton({
  blockedReason,
  onClick,
}: {
  blockedReason: MyOrganization["leaveBlockedReason"];
  onClick: () => void;
}) {
  if (blockedReason == null) {
    return (
      <Button variant="ghost" size="sm" onClick={onClick}>
        Leave
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="sm" disabled>
            Leave
          </Button>
        }
      />
      <TooltipContent side="left">{LEAVE_BLOCKED_COPY[blockedReason]}</TooltipContent>
    </Tooltip>
  );
}

function LeaveOrganizationDialog({
  open,
  onOpenChange,
  organizationId,
  organizationName,
  applicationCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  organizationName: string;
  applicationCount: number;
}) {
  const leaveOrganization = useLeaveOrganization();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Leave {organizationName}?</DialogTitle>
          <DialogDescription>
            You'll lose access to its {applicationCount === 1 ? "1 application" : `${applicationCount} applications`}.
            Its other members keep theirs, and they can invite you back.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            disabled={leaveOrganization.isPending}
            onClick={() => leaveOrganization.mutate({ organizationId }, { onSuccess: () => onOpenChange(false) })}
          >
            {leaveOrganization.isPending ? "Leaving..." : "Leave"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameOrganizationDialog({
  open,
  onOpenChange,
  organizationId,
  currentName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  currentName: string;
}) {
  const [name, setName] = useState(currentName);
  const renameOrganization = useRenameOrganization();
  const trimmed = name.trim();

  function submit() {
    if (trimmed.length === 0) return;
    renameOrganization.mutate({ organizationId, name: trimmed }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename organization</DialogTitle>
          <DialogDescription>This is what everyone in the organization sees.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-2">
            <Label htmlFor="org-name" className="font-mono text-2xs uppercase tracking-widest text-text-secondary">
              Name
            </Label>
            <Input
              id="org-name"
              value={name}
              placeholder="Acme Inc."
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={submit} disabled={trimmed.length === 0 || renameOrganization.isPending}>
            {renameOrganization.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
