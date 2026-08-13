/**
 * The disclaimer, as a badge on the mark it qualifies.
 *
 * It was a full-width strip in the primary colour above both bars, which made a solid band of the loudest colour
 * we have the first thing on every screen - it pulled the eye to the top of the page before the page itself, and
 * a permanent disclaimer that outshouts the content is worse than one that is merely present. Beside the
 * wordmark it says the same thing about the same subject, in a fraction of the area.
 *
 * Tinted rather than filled, for the same reason: the outline carries the colour without a block of it.
 *
 * Hidden below `xl`, which is not taste - it is the width. The pill costs about 150px, and with an admin's
 * third tab, an Upgrade call to action and a Finish setup prompt all on screen the bar has none to spare below
 * 1280: measured, it squeezed the application switcher from 288px to 102px at 1024 and to 2px at 768, which
 * loses the one thing in the bar that says which application you are looking at. A disclaimer is the least
 * operational thing here, so it is the thing that goes when something has to.
 */
export function EarlyVersionPill() {
  return (
    <span className="hidden shrink-0 border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-4xs font-semibold uppercase tracking-widest text-primary xl:inline-flex">
      Early version
    </span>
  );
}
