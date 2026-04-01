import {
  Badge,
  Button,
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Skeleton,
} from "@autonoma/blacklight";
import { BuildingsIcon } from "@phosphor-icons/react/Buildings";
import { CalendarBlankIcon } from "@phosphor-icons/react/CalendarBlank";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { CubeTransparentIcon } from "@phosphor-icons/react/CubeTransparent";
import { GiftIcon } from "@phosphor-icons/react/Gift";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { UsersIcon } from "@phosphor-icons/react/Users";
import { XIcon } from "@phosphor-icons/react/X";
import { Navigate, createFileRoute, useRouteContext, useRouter } from "@tanstack/react-router";
import { useAuth } from "lib/auth";
import { formatDate } from "lib/format";
import {
  type AdminPromoCodesInput,
  useAdminOrganizations,
  useAdminPendingOrgs,
  useApproveOrg,
  useAdminPromoCodes,
  useCreatePromoCodeAdmin,
  useCreateOrg,
  useRejectOrg,
  useSetPromoCodeActiveAdmin,
  useSwitchToOrg,
} from "lib/query/admin.queries";
import { Suspense, useState } from "react";

export const Route = createFileRoute("/_blacklight/_app-shell/admin/")({
  component: AdminPage,
});

type Tab = "organizations" | "pending" | "promoCodes";

// ─── Guard ────────────────────────────────────────────────────────────────────

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth();

  if (!isAdmin) {
    return <Navigate to="/" />;
  }

  return <>{children}</>;
}

// ─── Org row ──────────────────────────────────────────────────────────────────

interface OrgRowProps {
  org: {
    id: string;
    name: string;
    slug: string;
    createdAt: Date;
    memberCount: number;
    applicationCount: number;
  };
  activeOrgId: string | undefined;
  onActivate: (orgId: string) => void;
  isActivating: boolean;
}

function OrgRow({ org, activeOrgId, onActivate, isActivating }: OrgRowProps) {
  const isActive = activeOrgId === org.id;

  return (
    <div
      className={`flex items-center gap-4 rounded-md border px-4 py-3 transition-colors ${
        isActive
          ? "border-primary-ink/30 bg-primary-ink/5"
          : "border-border-dim bg-surface-base hover:bg-surface-raised"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-text-primary">{org.name}</p>
          {isActive && (
            <Badge variant="outline" className="text-3xs">
              Active
            </Badge>
          )}
        </div>
        <p className="mt-0.5 font-mono text-2xs text-text-tertiary">{org.slug}</p>
      </div>

      <div className="hidden items-center gap-6 shrink-0 sm:flex">
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
          <UsersIcon size={14} />
          <span>
            {org.memberCount} {org.memberCount === 1 ? "member" : "members"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
          <CubeTransparentIcon size={14} />
          <span>
            {org.applicationCount} {org.applicationCount === 1 ? "app" : "apps"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary shrink-0">
          <CalendarBlankIcon size={14} />
          <span>{formatDate(org.createdAt)}</span>
        </div>
      </div>

      <div className="shrink-0 w-20 flex justify-end">
        {isActive ? (
          <span className="text-2xs font-medium text-primary-ink">Current</span>
        ) : (
          <Button variant="outline" size="sm" disabled={isActivating} onClick={() => onActivate(org.id)}>
            {isActivating ? <SpinnerGapIcon size={12} className="animate-spin" /> : "Switch"}
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Org list ─────────────────────────────────────────────────────────────────

function OrgList() {
  const activeOrg = useRouteContext({
    from: "/_blacklight/_app-shell",
    select: (ctx) => ctx.activeOrganization,
  });
  const activeOrgId = activeOrg?.id;
  const [activatingId, setActivatingId] = useState<string | undefined>();
  const [search, setSearch] = useState("");

  const router = useRouter();
  const { data: orgs } = useAdminOrganizations();

  const q = search.toLowerCase().trim();
  const matched =
    q === "" ? orgs : orgs.filter((org) => org.name.toLowerCase().includes(q) || org.slug.toLowerCase().includes(q));
  const filteredOrgs = [...matched].sort((a: (typeof orgs)[number], b: (typeof orgs)[number]) => {
    if (a.id === activeOrgId) return -1;
    if (b.id === activeOrgId) return 1;
    return 0;
  });

  const switchMutation = useSwitchToOrg();

  function handleActivate(orgId: string) {
    setActivatingId(orgId);
    switchMutation.mutate(
      { orgId },
      {
        onSuccess: () => {
          setActivatingId(undefined);
          void router.navigate({ to: "/", reloadDocument: true });
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Input placeholder="Search organizations..." value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="flex flex-col gap-2">
        {filteredOrgs.map((org: (typeof orgs)[number]) => (
          <OrgRow
            key={org.id}
            org={org}
            activeOrgId={activeOrgId}
            onActivate={(id) => handleActivate(id)}
            isActivating={activatingId === org.id}
          />
        ))}
        {filteredOrgs.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-dim py-14 text-center">
            <BuildingsIcon size={24} className="text-text-tertiary" />
            <p className="text-sm text-text-tertiary">
              {search !== "" ? `No organizations matching "${search}"` : "No organizations found"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function OrgListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-16 w-full rounded-md" />
      ))}
    </div>
  );
}

function PromoCodesAdmin() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PromoCodeCreateCard />
      <Suspense fallback={<PromoCodeListSkeleton />}>
        <PromoCodeListCard />
      </Suspense>
    </div>
  );
}

function PromoCodeCreateCard() {
  const [code, setCode] = useState("");
  const [credits, setCredits] = useState("100000");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const createPromoCode = useCreatePromoCodeAdmin();

  function handleCreatePromoCode() {
    const normalizedCode = code.trim();
    const grantCredits = Number.parseInt(credits, 10);
    const max = maxRedemptions.trim() === "" ? null : Number.parseInt(maxRedemptions, 10);
    const expiration = endsAt.trim() === "" ? null : new Date(endsAt);
    if (normalizedCode.length === 0 || !Number.isFinite(grantCredits) || grantCredits <= 0) return;
    if (max != null && (!Number.isFinite(max) || max <= 0)) return;
    if (expiration != null && Number.isNaN(expiration.getTime())) return;

    createPromoCode.mutate(
      {
        code: normalizedCode,
        grantCredits,
        maxRedemptions: max,
        endsAt: expiration,
      },
      {
        onSuccess: () => {
          setCode("");
          setCredits("100000");
          setMaxRedemptions("");
          setEndsAt("");
        },
      },
    );
  }

  return (
    <div className="rounded-md border border-border-dim bg-surface-base p-4">
      <h2 className="text-sm font-medium text-text-primary">Create promo code</h2>
      <div className="mt-3 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="admin-promo-code">Name / code</Label>
          <Input
            id="admin-promo-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="0BUGS"
            aria-label="admin-promo-code-name"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="admin-promo-credits">Credits</Label>
          <Input
            id="admin-promo-credits"
            type="number"
            min={1}
            value={credits}
            onChange={(e) => setCredits(e.target.value)}
            aria-label="admin-promo-code-credits"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="admin-promo-max-redemptions">Max redemptions (optional)</Label>
          <Input
            id="admin-promo-max-redemptions"
            type="number"
            min={1}
            value={maxRedemptions}
            onChange={(e) => setMaxRedemptions(e.target.value)}
            aria-label="admin-promo-code-max-redemptions"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="admin-promo-expiration">Expires at (optional)</Label>
          <Input
            id="admin-promo-expiration"
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            aria-label="admin-promo-code-expires-at"
          />
          <p className="text-2xs text-text-tertiary">Timezone: local browser time (stored in UTC).</p>
        </div>
        <Button
          onClick={handleCreatePromoCode}
          disabled={code.trim().length === 0 || createPromoCode.isPending}
          aria-label="admin-promo-code-create"
        >
          {createPromoCode.isPending ? "Creating..." : "Create promo code"}
        </Button>
      </div>
    </div>
  );
}

function PromoCodeListCard() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const listInput: AdminPromoCodesInput = {
    page,
    pageSize,
    query: search.trim() === "" ? undefined : search.trim(),
    isActive: status === "all" ? undefined : status === "active",
  };
  const { data } = useAdminPromoCodes(listInput);
  const setPromoCodeActive = useSetPromoCodeActiveAdmin();

  return (
    <div className="rounded-md border border-border-dim bg-surface-base p-4">
      <h2 className="text-sm font-medium text-text-primary">Manage promo codes</h2>
      <div className="mt-3 space-y-3">
        <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_180px_140px]">
          <Input
            placeholder="Search code or description..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="h-9"
            aria-label="admin-promo-code-search"
          />
          <select
            className="h-9 rounded-md border border-border-dim bg-surface-base px-3 text-sm text-text-primary"
            value={status}
            onChange={(e) => {
              const value = e.target.value as "all" | "active" | "inactive";
              setStatus(value);
              setPage(1);
            }}
            aria-label="admin-promo-code-status-filter"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <select
            className="h-9 rounded-md border border-border-dim bg-surface-base px-3 text-sm text-text-primary"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number.parseInt(e.target.value, 10));
              setPage(1);
            }}
            aria-label="admin-promo-code-page-size"
          >
            <option value={10}>10 / page</option>
            <option value={20}>20 / page</option>
            <option value={50}>50 / page</option>
          </select>
        </div>

        {data.items.length === 0 ? (
          <p className="text-sm text-text-tertiary">No promo codes yet.</p>
        ) : (
          data.items.map((promo) => {
            const remaining =
              promo.maxRedemptions == null ? "∞" : Math.max(0, promo.maxRedemptions - promo.redeemedCount);

            return (
              <div key={promo.id} className="rounded-md border border-border-dim px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-2xs text-text-primary">{promo.code}</p>
                    <p className="font-mono text-3xs text-text-tertiary">
                      +{promo.grantCredits.toLocaleString()} credits · Remaining: {remaining}
                    </p>
                    <p className="font-mono text-3xs text-text-tertiary">
                      {promo.endsAt == null
                        ? "No expiration"
                        : `Expires ${new Date(promo.endsAt).toLocaleString()} (local)`}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() =>
                      setPromoCodeActive.mutate({
                        promoCodeId: promo.id,
                        isActive: !promo.isActive,
                      })
                    }
                    disabled={setPromoCodeActive.isPending}
                    aria-label={`admin-promo-code-toggle-${promo.code.toLowerCase()}`}
                  >
                    {promo.isActive ? "Disable" : "Enable"}
                  </Button>
                </div>
              </div>
            );
          })
        )}

        <div className="flex items-center justify-between pt-1">
          <p className="text-2xs text-text-tertiary">
            Page {data.page} of {data.totalPages} · {data.total} total
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={data.page <= 1}
              aria-label="admin-promo-code-prev-page"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
              disabled={data.page >= data.totalPages}
              aria-label="admin-promo-code-next-page"
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PromoCodeListSkeleton() {
  return <Skeleton className="h-[380px] w-full rounded-md" />;
}

// ─── Pending Approvals ────────────────────────────────────────────────────────

interface PendingOrgRowProps {
  org: {
    id: string;
    name: string;
    slug: string;
    domain: string | null;
    createdAt: Date;
    memberCount: number;
  };
  onApprove: (orgId: string) => void;
  onReject: (orgId: string) => void;
  isBusy: boolean;
}

function PendingOrgRow({ org, onApprove, onReject, isBusy }: PendingOrgRowProps) {
  return (
    <div className="flex items-center gap-4 rounded-md border border-status-warn/30 bg-status-warn/5 px-4 py-3 transition-colors">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-text-primary">{org.name}</p>
          <Badge variant="outline" className="text-3xs text-status-warn border-status-warn/30">
            Pending
          </Badge>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <p className="font-mono text-2xs text-text-tertiary">{org.slug}</p>
          {org.domain != null && (
            <div className="flex items-center gap-1 text-2xs text-text-tertiary">
              <GlobeIcon size={12} />
              <span>{org.domain}</span>
            </div>
          )}
        </div>
      </div>

      <div className="hidden items-center gap-6 shrink-0 sm:flex">
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
          <UsersIcon size={14} />
          <span>
            {org.memberCount} {org.memberCount === 1 ? "member" : "members"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary shrink-0">
          <CalendarBlankIcon size={14} />
          <span>{formatDate(org.createdAt)}</span>
        </div>
      </div>

      <div className="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" disabled={isBusy} onClick={() => onReject(org.id)}>
          <XIcon size={14} />
          Reject
        </Button>
        <Button size="sm" disabled={isBusy} onClick={() => onApprove(org.id)}>
          <CheckIcon size={14} />
          Approve
        </Button>
      </div>
    </div>
  );
}

function PendingOrgList() {
  const [busyId, setBusyId] = useState<string | undefined>();

  const { data: pendingOrgs } = useAdminPendingOrgs();
  const approveMutation = useApproveOrg();
  const rejectMutation = useRejectOrg();

  function handleApprove(orgId: string) {
    setBusyId(orgId);
    approveMutation.mutate({ orgId }, { onSuccess: () => setBusyId(undefined) });
  }

  function handleReject(orgId: string) {
    setBusyId(orgId);
    rejectMutation.mutate({ orgId }, { onSuccess: () => setBusyId(undefined) });
  }

  return (
    <div className="flex flex-col gap-2">
      {pendingOrgs.map((org) => (
        <PendingOrgRow
          key={org.id}
          org={org}
          onApprove={handleApprove}
          onReject={handleReject}
          isBusy={busyId === org.id}
        />
      ))}
      {pendingOrgs.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-dim py-14 text-center">
          <CheckCircleIcon size={24} className="text-text-tertiary" />
          <p className="text-sm text-text-tertiary">No pending approvals</p>
        </div>
      )}
    </div>
  );
}

// ─── Create Organization ──────────────────────────────────────────────────────

function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const createMutation = useCreateOrg();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (name.trim() === "" || domain.trim() === "") return;
    createMutation.mutate(
      { name: name.trim(), slug, domain: domain.trim() },
      {
        onSuccess: () => {
          onOpenChange(false);
          setName("");
          setDomain("");
        },
      },
    );
  }

  const isValid = name.trim() !== "" && domain.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create organization</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 py-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-name">Name</Label>
            <Input
              id="org-name"
              placeholder="Acme Inc."
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            {slug !== "" && <p className="font-mono text-2xs text-text-tertiary">Slug: {slug}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-domain">Domain</Label>
            <Input id="org-domain" placeholder="acme.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
          </div>
          {createMutation.error != null && (
            <p className="text-sm text-status-critical">{createMutation.error.message}</p>
          )}
        </form>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            onClick={() => {
              if (isValid) {
                createMutation.mutate(
                  { name: name.trim(), slug, domain: domain.trim() },
                  {
                    onSuccess: () => {
                      onOpenChange(false);
                      setName("");
                      setDomain("");
                    },
                  },
                );
              }
            }}
            disabled={!isValid || createMutation.isPending}
          >
            {createMutation.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function AdminContent() {
  const [tab, setTab] = useState<Tab>("organizations");
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <section className="flex-1 overflow-auto p-6 lg:p-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-medium tracking-tight text-text-primary">Admin</h1>
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              Manage organizations, approve access requests, and debug accounts.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon size={14} />
              Create organization
            </Button>
            <div className="flex rounded-md border border-border-dim">
              <button
                type="button"
                onClick={() => setTab("organizations")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-2xs font-medium transition-colors rounded-l-md ${
                  tab === "organizations"
                    ? "bg-surface-raised text-text-primary"
                    : "text-text-tertiary hover:text-text-primary"
                }`}
              >
                <BuildingsIcon size={14} />
                Organizations
              </button>
              <button
                type="button"
                onClick={() => setTab("pending")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-2xs font-medium transition-colors ${
                  tab === "pending"
                    ? "bg-surface-raised text-text-primary"
                    : "text-text-tertiary hover:text-text-primary"
                }`}
              >
                <ClockIcon size={14} />
                Pending
              </button>
              <button
                type="button"
                onClick={() => setTab("promoCodes")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-2xs font-medium transition-colors rounded-r-md ${
                  tab === "promoCodes"
                    ? "bg-surface-raised text-text-primary"
                    : "text-text-tertiary hover:text-text-primary"
                }`}
              >
                <GiftIcon size={14} />
                Promo codes
              </button>
            </div>
          </div>
        </div>

        {tab === "organizations" && (
          <Suspense fallback={<OrgListSkeleton />}>
            <OrgList />
          </Suspense>
        )}

        {tab === "pending" && (
          <Suspense fallback={<OrgListSkeleton />}>
            <PendingOrgList />
          </Suspense>
        )}

        {tab === "promoCodes" && (
          <Suspense fallback={<OrgListSkeleton />}>
            <PromoCodesAdmin />
          </Suspense>
        )}
      </div>

      <CreateOrgDialog open={createOpen} onOpenChange={setCreateOpen} />
    </section>
  );
}

function AdminPage() {
  return (
    <AdminGuard>
      <AdminContent />
    </AdminGuard>
  );
}
