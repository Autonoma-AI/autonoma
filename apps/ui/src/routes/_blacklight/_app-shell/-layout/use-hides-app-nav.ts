import { useMatchRoute } from "@tanstack/react-router";

/**
 * Whether the current route runs without the app nav.
 *
 * Finish setup is a linear task the app can't run generations without, and its own stepper is the only
 * progress that matters there - the app nav beside it reads as a competing second set of steps.
 *
 * Shared with the shell's loading silhouette: the skeleton has to reach the same answer as the layout it
 * stands in for, or a cold landing on finish setup draws a sidebar that never arrives.
 */
export function useHidesAppNav(): boolean {
    const matchRoute = useMatchRoute();
    return matchRoute({ to: "/app/$appSlug/finish-setup" }) !== false;
}
