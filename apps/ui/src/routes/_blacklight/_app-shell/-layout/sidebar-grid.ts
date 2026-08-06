const EXPANDED_WIDTH = "200px";
const COLLAPSED_WIDTH = "60px";

/**
 * The app shell's two-column track. Shared so the shell's loading silhouette lines up with the real
 * sidebar to the pixel - a skeleton that guesses the width shifts the whole page when the shell arrives.
 */
export function sidebarGridTemplate(collapsed: boolean): string {
    return `${collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH} 1fr`;
}
