import { Button, Separator, Tooltip, TooltipContent, TooltipTrigger } from "@autonoma/blacklight";
import { BrowsersIcon } from "@phosphor-icons/react/Browsers";
import { BugIcon } from "@phosphor-icons/react/Bug";
import { CaretLineLeftIcon } from "@phosphor-icons/react/CaretLineLeft";
import { CaretLineRightIcon } from "@phosphor-icons/react/CaretLineRight";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/ChatCircleDots";
import { CrownSimpleIcon } from "@phosphor-icons/react/CrownSimple";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { GridFourIcon } from "@phosphor-icons/react/GridFour";
import { HouseIcon } from "@phosphor-icons/react/House";
import type { Icon } from "@phosphor-icons/react/lib";
import { ShieldCheckIcon } from "@phosphor-icons/react/ShieldCheck";
import { SignOutIcon } from "@phosphor-icons/react/SignOut";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/SlidersHorizontal";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams, useRouteContext } from "@tanstack/react-router";
import { useAuth, useAuthClient } from "lib/auth";
import { CHECKOUT_TYPE_SUBSCRIPTION } from "lib/billing/formatters";
import { useOnboardingStateOptional } from "lib/onboarding/onboarding-api";
import { useCreateCheckoutSession } from "lib/query/billing.queries";
import { trpc } from "lib/trpc";
import { useEffect, useState } from "react";
import { SidebarAppSelector } from "./app-selector";
import { SidebarAgentStatus } from "./sidebar-agent-status";
import { SidebarMilestones } from "./sidebar-milestones";

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
  const { isAdmin } = useAuth();
  const app = params.appSlug != null ? applications.find((a) => a.slug === params.appSlug) : undefined;
  const { data: onboardingState } = useOnboardingStateOptional(app?.id ?? "");

  if (params.appSlug == null || app == null) return { items: [] as NavItem[], tools: [] as NavItem[] };

  const base = `/app/${params.appSlug}`;

  const items: NavItem[] = [
    { icon: HouseIcon, label: "Home", href: base, exact: true },
    { icon: GitPullRequestIcon, label: "Pull Requests", href: `${base}/pull-requests` },
    { icon: BrowsersIcon, label: "Preview Environments", href: `${base}/preview-environments` },
    { icon: BugIcon, label: "Tests", href: `${base}/tests` },
  ];

  const tools: NavItem[] = [];
  // Show "Finish setup" until all three deepening steps are complete.
  if (onboardingState != null && !onboardingState.setupComplete) {
    tools.push({ icon: SlidersHorizontalIcon, label: "Finish setup", href: `${base}/finish-setup` });
  }
  tools.push({ icon: GearSixIcon, label: "Settings", href: `${base}/settings` });

  if (isAdmin) {
    tools.push({ icon: ShieldCheckIcon, label: "App admin", href: `${base}/admin` });
  }

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
      <div className={`flex shrink-0 flex-col gap-2 ${collapsed ? "px-2 py-3" : "px-3 py-3"}`}>
        <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between gap-2"}`}>
          {!collapsed && (
            <span className="truncate font-mono text-3xs uppercase tracking-widest text-text-tertiary">
              {activeOrganization.name}
            </span>
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
        {hasAppNav && <SidebarAppSelector collapsed={collapsed} />}
      </div>

      {/* Milestones */}
      {hasAppNav && (
        <div className="border-b border-border-dim">
          <SidebarMilestones collapsed={collapsed} />
        </div>
      )}

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
