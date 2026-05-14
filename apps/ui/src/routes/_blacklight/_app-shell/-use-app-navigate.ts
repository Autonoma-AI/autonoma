import { useNavigate, useParams } from "@tanstack/react-router";

export function useAppNavigate() {
    const { appSlug } = useParams({ from: "/_blacklight/_app-shell/app/$appSlug" });
    const navigate = useNavigate();

    return function appNavigate(opts: { to: string; params?: Record<string, string>; replace?: boolean }) {
        return navigate({
            to: opts.to as "/",
            params: { ...opts.params, appSlug } as never,
            replace: opts.replace,
        });
    };
}
