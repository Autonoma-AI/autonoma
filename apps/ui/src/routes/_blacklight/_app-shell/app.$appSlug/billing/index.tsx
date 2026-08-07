import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Billing became a destination inside settings (#2130). This route stays behind it, because the URL outlived
 * the page that used to answer it.
 *
 * Stripe is what makes it load-bearing rather than a courtesy: `billing-customer.service.ts` builds every
 * app-scoped checkout `success_url` as `/app/<slug>/billing`, so without this the screen a customer sees
 * immediately after paying is a not-found page. That holds for sessions already created too - their success
 * URL is fixed at the provider and no deploy can rewrite it - which is why this has to answer here rather than
 * being solved by pointing the server somewhere else. Bookmarks and links already sent survive with it.
 *
 * Stripe appends `?session_id=`, which nothing in the app reads; it is dropped rather than threaded through a
 * route that would have to declare it to keep it.
 */
export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/billing/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/app/$appSlug/settings/billing", params, replace: true });
  },
});
