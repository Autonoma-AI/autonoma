import { Button, Separator, Tooltip, TooltipContent, TooltipTrigger } from "@autonoma/blacklight";
import { BugIcon } from "@phosphor-icons/react/Bug";
import { BugBeetleIcon } from "@phosphor-icons/react/BugBeetle";
import { CaretLineLeftIcon } from "@phosphor-icons/react/CaretLineLeft";
import { CaretLineRightIcon } from "@phosphor-icons/react/CaretLineRight";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/ChatCircleDots";
import { CrownSimpleIcon } from "@phosphor-icons/react/CrownSimple";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { GridFourIcon } from "@phosphor-icons/react/GridFour";
import type { Icon } from "@phosphor-icons/react/lib";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { PlayIcon } from "@phosphor-icons/react/Play";
import { RocketLaunchIcon } from "@phosphor-icons/react/RocketLaunch";
import { ShieldCheckIcon } from "@phosphor-icons/react/ShieldCheck";
import { SignOutIcon } from "@phosphor-icons/react/SignOut";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams, useRouteContext } from "@tanstack/react-router";
import { useAuth, useAuthClient } from "lib/auth";
import { CHECKOUT_TYPE_SUBSCRIPTION } from "lib/billing/formatters";
import { useCreateCheckoutSession } from "lib/query/billing.queries";
import { trpc } from "lib/trpc";
import { useEffect, useState } from "react";
import { SidebarAgentStatus } from "./sidebar-agent-status";

const SIDEBAR_STORAGE_KEY = "autonoma:sidebar-collapsed";

interface NavItem {
  icon: Icon;
  label: string;
  href: string;
  exact?: boolean;
}

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
    } catch {
      // ignore
    }
  }, [collapsed]);

  return [collapsed, setCollapsed] as const;
}

function useAppNav() {
  const applications = useRouteContext({ from: "/_blacklight/_app-shell", select: (ctx) => ctx.applications });
  const params = useParams({ strict: false }) as { appSlug?: string };

  if (params.appSlug == null) return { items: [] as NavItem[], tools: [] as NavItem[] };

  const app = applications.find((a) => a.slug === params.appSlug);
  if (app == null) return { items: [] as NavItem[], tools: [] as NavItem[] };

  const base = `/app/${params.appSlug}`;

  const items: NavItem[] = [
    { icon: GridFourIcon, label: "Home", href: base, exact: true },
    { icon: LightningIcon, label: "Generations", href: `${base}/generations` },
    { icon: WarningIcon, label: "Issues", href: `${base}/issues` },
    { icon: BugBeetleIcon, label: "Bugs", href: `${base}/bugs` },
    { icon: PlayIcon, label: "Runs", href: `${base}/runs` },
    { icon: BugIcon, label: "Tests", href: `${base}/tests` },
    { icon: GitPullRequestIcon, label: "Pull Requests", href: `${base}/pull-requests` },
    { icon: RocketLaunchIcon, label: "Deployments", href: `${base}/deployments` },
  ];

  const tools: NavItem[] = [{ icon: GearSixIcon, label: "Settings", href: `${base}/settings` }];

  return { items, tools };
}

const ADMIN_NAV_ITEMS: NavItem[] = [{ icon: ShieldCheckIcon, label: "Admin", href: "/admin", exact: true }];

function isNavItemActive(pathname: string, href: string, exact?: boolean) {
  if (exact === true) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarNavItem({
  icon: ItemIcon,
  label,
  href,
  active,
  collapsed,
}: {
  icon: Icon;
  label: string;
  href: string;
  active: boolean;
  collapsed: boolean;
}) {
  const inner = (
    <Link to={href} className="block">
      <span
        className={`flex items-center gap-3 py-2 text-xs font-medium transition-colors ${
          collapsed ? "justify-center rounded px-2" : "rounded-r px-4 border-l-2"
        } ${
          active
            ? collapsed
              ? "bg-surface-raised text-primary-ink"
              : "border-primary-ink bg-surface-raised text-text-primary"
            : collapsed
              ? "text-text-secondary hover:bg-surface-raised hover:text-text-primary"
              : "border-transparent text-text-secondary hover:bg-surface-raised hover:text-text-primary"
        }`}
      >
        <ItemIcon size={18} weight={active ? "fill" : "regular"} className="shrink-0" />
        {!collapsed && label}
      </span>
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger render={<div />}>{inner}</TooltipTrigger>
        <TooltipContent side="right" align="start">
          {label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return inner;
}

const SUBSCRIBED_STATUSES = new Set(["active", "trialing"]);

function SidebarUpgradeButton({ collapsed }: { collapsed: boolean }) {
  const { data } = useQuery(trpc.billing.status.queryOptions());
  const createCheckout = useCreateCheckoutSession();

  const isSubscribed = data?.subscriptionStatus != null && SUBSCRIBED_STATUSES.has(data.subscriptionStatus);
  if (data == null || isSubscribed) return null;

  function handleUpgrade() {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    createCheckout.mutate(
      { type: CHECKOUT_TYPE_SUBSCRIPTION, returnPath },
      {
        onSuccess: (result) => {
          if (result.url == null) return;
          window.location.href = result.url;
        },
      },
    );
  }

  if (collapsed) {
    return (
      <div className="border-b border-border-dim p-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="cta"
                size="icon-xs"
                onClick={handleUpgrade}
                disabled={createCheckout.isPending}
                className="w-full"
              />
            }
          >
            <CrownSimpleIcon size={14} weight="fill" />
          </TooltipTrigger>
          <TooltipContent side="right">Upgrade</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="border-b border-border-dim p-3">
      <Button variant="cta" onClick={handleUpgrade} disabled={createCheckout.isPending} className="w-full gap-2">
        <CrownSimpleIcon size={14} weight="fill" />
        Upgrade
      </Button>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onFeedback: () => void;
}

function Sidebar({ collapsed, onToggleCollapsed, onFeedback }: SidebarProps) {
  const { user, isAdmin } = useAuth();
  const authClient = useAuthClient();
  const activeOrganization = useRouteContext({
    from: "/_blacklight/_app-shell",
    select: (ctx) => ctx.activeOrganization,
  });
  const { items: appNavItems, tools: toolItems } = useAppNav();
  const { pathname } = useLocation();
  const isAdminPage = pathname === "/admin" || pathname.startsWith("/admin/");

  const hasAppNav = appNavItems.length > 0;

  let navItems: NavItem[];
  let navToolItems: NavItem[];

  if (hasAppNav) {
    navItems = appNavItems;
    navToolItems = toolItems;
  } else if (isAdminPage && isAdmin) {
    navItems = ADMIN_NAV_ITEMS;
    navToolItems = [];
  } else {
    navItems = [];
    navToolItems = [];
  }

  const handleSignOut = () => {
    void authClient.signOut().then(() => {
      window.location.href = "/login";
    });
  };

  return (
    <aside className="flex flex-col border-r border-border-dim bg-surface-base">
      {/* Header */}
      <div
        className={`flex h-14 shrink-0 items-center justify-between border-b border-border-dim ${collapsed ? "justify-center px-2" : "px-4"}`}
      >
        {!collapsed && (
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex size-6 shrink-0 items-center justify-center bg-primary font-mono text-3xs font-bold text-primary-foreground">
              {activeOrganization.name.charAt(0).toUpperCase()}
            </div>
            <span className="truncate text-xs font-medium text-text-primary">{activeOrganization.name}</span>
          </div>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onToggleCollapsed}
                className="shrink-0 text-text-tertiary hover:text-text-primary"
              />
            }
          >
            {collapsed ? <CaretLineRightIcon size={14} /> : <CaretLineLeftIcon size={14} />}
          </TooltipTrigger>
          <TooltipContent side={collapsed ? "right" : "bottom"}>{collapsed ? "Expand" : "Collapse"}</TooltipContent>
        </Tooltip>
      </div>

      {/* Nav items */}
      <div className={`flex-1 overflow-y-auto overflow-x-hidden ${collapsed ? "px-1 py-3" : "py-3"}`}>
        <nav className="flex flex-col gap-0.5">
          {navItems.map(({ icon, label, href, exact }) => (
            <SidebarNavItem
              key={label}
              icon={icon}
              label={label}
              href={href}
              active={isNavItemActive(pathname, href, exact)}
              collapsed={collapsed}
            />
          ))}
        </nav>

        <Separator className="my-3" />

        <nav className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={onFeedback}
            className={`flex w-full items-center gap-3 py-2 text-xs font-medium text-text-secondary transition-colors cursor-pointer hover:bg-surface-raised hover:text-text-primary ${
              collapsed ? "justify-center rounded px-2" : "rounded-r border-l-2 border-transparent px-4"
            }`}
          >
            <ChatCircleDotsIcon size={18} className="shrink-0" />
            {!collapsed && "Feedback"}
          </button>
        </nav>

        {navToolItems.length > 0 && (
          <>
            <Separator className="my-3" />
            <nav className="flex flex-col gap-0.5">
              {navToolItems.map(({ icon, label, href, exact }) => (
                <SidebarNavItem
                  key={label}
                  icon={icon}
                  label={label}
                  href={href}
                  active={isNavItemActive(pathname, href, exact)}
                  collapsed={collapsed}
                />
              ))}
            </nav>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border-dim">
        <SidebarAgentStatus collapsed={collapsed} />
        <SidebarUpgradeButton collapsed={collapsed} />

        {isAdmin && !isAdminPage && (
          <Link
            to="/admin"
            className={`flex items-center gap-2 border-b border-border-dim px-4 py-2.5 text-2xs font-medium transition-colors hover:bg-surface-raised ${collapsed ? "justify-center px-2" : ""}`}
          >
            <ShieldCheckIcon size={14} />
            {!collapsed && "Admin"}
          </Link>
        )}

        {isAdminPage && (
          <Link
            to="/"
            className={`flex items-center gap-2 border-b border-border-dim px-4 py-2.5 text-2xs font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary ${collapsed ? "justify-center px-2" : ""}`}
          >
            <GridFourIcon size={14} />
            {!collapsed && "Back to apps"}
          </Link>
        )}

        <div className={`flex items-center ${collapsed ? "justify-center p-2" : "justify-between gap-2 px-4 py-3"}`}>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-text-primary">{user?.name ?? user?.email ?? "User"}</p>
              {activeOrganization != null && (
                <p className="truncate font-mono text-3xs text-text-tertiary">{activeOrganization.name}</p>
              )}
            </div>
          )}

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleSignOut}
                  className="shrink-0 text-text-tertiary hover:text-status-critical"
                />
              }
            >
              <SignOutIcon size={14} />
            </TooltipTrigger>
            <TooltipContent side={collapsed ? "right" : "top"}>Sign out</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </aside>
  );
}

export { Sidebar, useSidebarCollapsed, useAppNav };
