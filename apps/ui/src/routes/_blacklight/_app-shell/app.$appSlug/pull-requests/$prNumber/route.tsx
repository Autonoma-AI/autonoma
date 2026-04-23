import { Outlet, createFileRoute, notFound } from "@tanstack/react-router";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber")({
  parseParams: ({ prNumber, ...rest }) => ({ ...rest, prNumber: Number(prNumber) }),
  stringifyParams: ({ prNumber, ...rest }) => ({ ...rest, prNumber: String(prNumber) }),
  beforeLoad: ({ params: { prNumber } }) => {
    if (!Number.isFinite(prNumber) || prNumber <= 0) throw notFound();
  },
  component: Outlet,
});
