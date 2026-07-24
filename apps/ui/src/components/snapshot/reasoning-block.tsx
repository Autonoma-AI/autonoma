import { type OverlayPoint } from "@autonoma/blacklight";
import { EVIDENCE_TOKEN_SCHEME, FINDING_TOKEN_SCHEME, ISSUE_TOKEN_SCHEME } from "@autonoma/types";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { LightbulbIcon } from "@phosphor-icons/react/Lightbulb";
import { ScreenshotLightbox } from "components/screenshot-lightbox";
import { type ReactNode, useState } from "react";
import Markdown, { defaultUrlTransform, type ExtraProps } from "react-markdown";

// The inline-token schemes the renderer preserves through react-markdown's URL sanitizer (which strips unknown
// protocols by default): the evidence image scheme plus the analysis issue/finding link schemes.
const PRESERVED_TOKEN_SCHEMES = [EVIDENCE_TOKEN_SCHEME, ISSUE_TOKEN_SCHEME, FINDING_TOKEN_SCHEME];

/**
 * Resolve an `issue:`/`finding:` link token into a rendered node. The consumer supplies these (they know the
 * route params and which ids/slugs actually exist): a known id/slug returns an in-app link, an unknown one
 * returns the token's plain text - so a fabricated reference "renders as nothing", the link counterpart of an
 * unbacked `evidence:` image rendering as no image.
 */
export interface ReasoningLinkResolvers {
  renderIssueLink?: (issueId: string, children: ReactNode) => ReactNode;
  renderFindingLink?: (slug: string, children: ReactNode) => ReactNode;
}

/**
 * One narrative-embedded evidence asset, resolved to a signed URL by the API.
 * The narrative references it by `evidence:<assetId>` token; the renderer looks it
 * up here and renders the image inline (with pin + lightbox), or nothing when the
 * token has no resolved asset.
 */
export interface InlineEvidence {
  assetId: string;
  url: string;
  kind: "screenshot" | "step_output";
  pin?: OverlayPoint;
}

interface ReasoningBlockProps {
  label: string;
  content: string;
}

export function ReasoningBlock({ label, content }: ReasoningBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border-dim bg-surface-base">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-surface-raised/40"
      >
        <LightbulbIcon size={12} className="text-text-tertiary" />
        <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">{label}</span>
        <CaretDownIcon
          size={12}
          className={`ml-auto text-text-tertiary transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div className="border-t border-border-dim px-4 py-3">
          <ReasoningMarkdown content={content} />
        </div>
      )}
    </div>
  );
}

export function ReasoningMarkdown({
  content,
  evidence,
  renderIssueLink,
  renderFindingLink,
}: { content: string; evidence?: InlineEvidence[] } & ReasoningLinkResolvers) {
  const evidenceById = new Map((evidence ?? []).map((asset) => [asset.assetId, asset]));

  return (
    <article className="prose prose-sm prose-invert max-w-none">
      <Markdown
        // Preserve our custom token schemes (evidence:/issue:/finding:); react-markdown strips unknown
        // protocols by default. Everything else still goes through the safe transform.
        urlTransform={(url) =>
          PRESERVED_TOKEN_SCHEMES.some((scheme) => url.startsWith(scheme)) ? url : defaultUrlTransform(url)
        }
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 border-b border-border-dim pb-2 text-base font-semibold text-text-primary">
              {children}
            </h1>
          ),
          h2: ({ children }) => <h2 className="mb-2 mt-5 text-sm font-semibold text-text-primary">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1.5 mt-4 text-sm font-medium text-text-primary">{children}</h3>,
          // A paragraph holding an image (alone or mid-sentence) must not render as
          // <p>: the inline evidence renders a block element, and a block inside <p>
          // is invalid DOM. A <div> with the same text styling keeps the prose intact.
          p: ({ node, children }) =>
            paragraphContainsImage(node) ? (
              <div className="mb-3 text-sm leading-relaxed text-text-primary">{children}</div>
            ) : (
              <p className="mb-3 text-sm leading-relaxed text-text-primary">{children}</p>
            ),
          strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
          code: ({ children }) => (
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-xs text-text-primary">
              {children}
            </code>
          ),
          ul: ({ children }) => (
            <ul className="mb-3 list-inside list-disc space-y-1 text-sm text-text-primary">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 list-inside list-decimal space-y-1 text-sm text-text-primary">{children}</ol>
          ),
          li: ({ children }) => <li className="text-sm text-text-primary">{children}</li>,
          img: ({ src, alt }) => (
            <InlineEvidenceImage
              src={typeof src === "string" ? src : undefined}
              alt={alt}
              evidenceById={evidenceById}
            />
          ),
          a: ({ href, children }) => (
            <InlineTokenLink
              href={typeof href === "string" ? href : undefined}
              renderIssueLink={renderIssueLink}
              renderFindingLink={renderFindingLink}
            >
              {children}
            </InlineTokenLink>
          ),
        }}
      >
        {content}
      </Markdown>
    </article>
  );
}

/**
 * Render a narrative link. An `issue:<id>` / `finding:<slug>` token is dispatched to the consumer's resolver,
 * which returns an in-app link for a known id/slug or the plain text for an unknown one (so a fabricated token
 * renders as nothing). A token with no resolver, and any other href, renders as an ordinary external link.
 */
function InlineTokenLink({
  href,
  children,
  renderIssueLink,
  renderFindingLink,
}: { href?: string; children: ReactNode } & ReasoningLinkResolvers) {
  if (href != null && href.startsWith(ISSUE_TOKEN_SCHEME)) {
    const issueId = href.slice(ISSUE_TOKEN_SCHEME.length);
    return <>{renderIssueLink != null ? renderIssueLink(issueId, children) : children}</>;
  }
  if (href != null && href.startsWith(FINDING_TOKEN_SCHEME)) {
    const slug = href.slice(FINDING_TOKEN_SCHEME.length);
    return <>{renderFindingLink != null ? renderFindingLink(slug, children) : children}</>;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
      {children}
    </a>
  );
}

function paragraphContainsImage(node: ExtraProps["node"]): boolean {
  if (node == null) return false;
  return node.children.some((child) => child.type === "element" && child.tagName === "img");
}

/**
 * Render a narrative image. The content is agent-authored, so a resolvable
 * `evidence:<assetId>` token is the ONLY src that renders: a known screenshot
 * appears inline with its pin overlay and click-to-zoom lightbox. Everything else -
 * an unknown token, a raw storage path or URL the agent fabricated - renders
 * nothing, never a broken image; only evidence the agent really fetched (and the
 * API resolved) can appear.
 */
function InlineEvidenceImage({
  src,
  alt,
  evidenceById,
}: {
  src?: string;
  alt?: string;
  evidenceById: Map<string, InlineEvidence>;
}) {
  if (src == null || !src.startsWith(EVIDENCE_TOKEN_SCHEME)) return null;

  const assetId = src.slice(EVIDENCE_TOKEN_SCHEME.length);
  const asset = evidenceById.get(assetId);
  if (asset == null || asset.kind !== "screenshot") return null;

  return (
    <div className="my-3 flex flex-col gap-1.5">
      <ScreenshotLightbox
        src={asset.url}
        alt={alt != null && alt.length > 0 ? alt : "Bug evidence screenshot"}
        className="w-full border border-border-dim"
        points={asset.pin != null ? [asset.pin] : undefined}
      />
      {alt != null && alt.length > 0 && <span className="text-xs italic text-text-secondary">{alt}</span>}
    </div>
  );
}
