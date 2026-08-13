import { BugIcon } from "@phosphor-icons/react/Bug";
import { CreditCardIcon } from "@phosphor-icons/react/CreditCard";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { HouseIcon } from "@phosphor-icons/react/House";
import type { Icon } from "@phosphor-icons/react/lib";
import { ShieldCheckIcon } from "@phosphor-icons/react/ShieldCheck";
import { useLocation, useParams, useRouteContext } from "@tanstack/react-router";
import { useAuth } from "lib/auth";

/**
 * What the chrome is currently scoped to. `none` is the signal that what you are looking at is not about one
 * application - organization settings, the finish-setup flow, the app picker - and it is what makes the shell
 * fall back to the minimal bar.
 */
export type AppNavScope = "application" | "admin" | "none";

export interface AppNavItem {
    icon: Icon;
    label: string;
    href: string;
    exact?: boolean;
}

export interface AppNav {
    scope: AppNavScope;
    /** The global switch: the destinations a reader moves between, in the order they matter. */
    sections: AppNavItem[];
    settings?: AppNavItem;
    /** Organization-scoped, but only routed under an application today - so it is absent without one. */
    billing?: AppNavItem;
}

const ADMIN_SECTIONS: AppNavItem[] = [{ icon: ShieldCheckIcon, label: "Admin", href: "/admin", exact: true }];

const EMPTY_NAV: AppNav = { scope: "none", sections: [] };

/**
 * Every destination the chrome offers, and what it is scoped to.
 *
 * The scope is stated rather than inferred. Both the bar and the shell used to work it out for themselves from
 * whether the section list came back empty, which meant two places had to agree about what an empty list meant,
 * and the admin substitution lived in only one of them.
 *
 * Settings and billing are named fields rather than a second array because they no longer render together -
 * an array would only tell a caller their order, which is no longer a fact about them.
 *
 * There is no Finish setup entry: `app.$appSlug/route.tsx` redirects an application that has not finished
 * onboarding into the flow before any of this renders, so a prompt here could only ever be dead.
 */
export function useAppNav(): AppNav {
    const applications = useRouteContext({ from: "/_blacklight/_app-shell", select: (ctx) => ctx.applications });
    const params = useParams({ strict: false });
    const { pathname } = useLocation();
    const { isAdmin } = useAuth();
    const app = params.appSlug != null ? applications.find((a) => a.slug === params.appSlug) : undefined;

    if (params.appSlug == null || app == null) {
        const isAdminPage = pathname === "/admin" || pathname.startsWith("/admin/");
        if (isAdminPage && isAdmin) return { scope: "admin", sections: ADMIN_SECTIONS };
        return EMPTY_NAV;
    }

    const base = `/app/${params.appSlug}`;

    const sections: AppNavItem[] = [
        { icon: HouseIcon, label: "Home", href: `${base}/pull-requests` },
        { icon: BugIcon, label: "Tests", href: `${base}/tests` },
    ];

    // App admin is a destination inside this application, so it sits beside the other two rather than in the
    // account menu - the rail carried it in the navigation for the same reason. `isAdmin` is false for every
    // customer, so nobody outside Autonoma ever renders a third tab.
    if (isAdmin) {
        sections.push({ icon: ShieldCheckIcon, label: "App admin", href: `${base}/admin` });
    }

    return {
        scope: "application",
        sections,
        settings: { icon: GearSixIcon, label: "Settings", href: `${base}/settings` },
        // Billing is a destination inside settings rather than a route of its own (#2130), so the menu points
        // at the page that actually exists - it is still listed separately because someone hunting for an
        // invoice looks for the word, not for Settings.
        billing: { icon: CreditCardIcon, label: "Credits and billing", href: `${base}/settings/billing` },
    };
}
