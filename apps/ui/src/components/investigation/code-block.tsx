import { Badge } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { FileCodeIcon } from "@phosphor-icons/react/FileCode";
import { Highlight, themes } from "prism-react-renderer";

// Syntax-highlighted code block for investigation evidence: an optional header (source tag + file:lines +
// GitHub permalink) over a Prism-highlighted body. Language is inferred from the file extension.

function languageForFile(file: string | undefined): string {
  const ext = file?.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "jsx";
    case "py":
      return "python";
    case "sql":
      return "sql";
    case "json":
      return "json";
    case "css":
      return "css";
    case "go":
      return "go";
    case "rb":
      return "ruby";
    case "java":
      return "java";
    case "rs":
      return "rust";
    case "php":
      return "php";
    case "sh":
    case "bash":
      return "bash";
    default:
      return "tsx";
  }
}

export function CodeBlock({
  code,
  file,
  lines,
  sourceLabel,
  permalink,
}: {
  code: string;
  file?: string;
  lines?: string;
  sourceLabel?: string;
  permalink?: string;
}) {
  const showHeader = file != null || sourceLabel != null;
  return (
    <div className="overflow-hidden rounded-md border border-border-dim">
      {showHeader && (
        <div className="flex items-center gap-2 bg-surface-raised px-3 py-2 font-mono text-3xs text-text-secondary">
          {sourceLabel != null && (
            <Badge variant="outline" className="uppercase">
              {sourceLabel}
            </Badge>
          )}
          {file != null && (
            <span className="flex items-center gap-1 truncate text-text-primary">
              <FileCodeIcon size={12} className="shrink-0" />
              {file}
              {lines != null ? `:${lines}` : ""}
            </span>
          )}
          {permalink != null && (
            <a
              href={permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto flex shrink-0 items-center gap-1 text-text-secondary transition-colors hover:text-text-primary"
            >
              <ArrowSquareOutIcon size={12} />
              GitHub
            </a>
          )}
        </div>
      )}
      <Highlight code={code.replace(/\n$/, "")} language={languageForFile(file)} theme={themes.vsDark}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="overflow-x-auto bg-surface-void p-3 font-mono text-2xs leading-relaxed">
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line });
              return (
                <div key={i} className={lineProps.className} style={lineProps.style}>
                  {line.map((token, k) => {
                    const tokenProps = getTokenProps({ token });
                    return (
                      <span key={k} className={tokenProps.className} style={tokenProps.style}>
                        {token.content}
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

/** Build a GitHub permalink to a file + line range at a specific commit, when we know the repo and sha. */
export function githubPermalink(
  repoFullName: string | undefined,
  commitSha: string | undefined,
  file: string | undefined,
  lines: string | undefined,
): string | undefined {
  if (repoFullName == null || commitSha == null || file == null) return undefined;
  return `https://github.com/${repoFullName}/blob/${commitSha}/${file}${lineAnchor(lines)}`;
}

/**
 * The permalink for one evidence/code reference. `repoFullName`/`commitSha` identify the PRIMARY repo, so only a
 * primary-repo reference can be linked: a dependency reference (`repo` set) would resolve to
 * primary-repo/blob/<primary-sha>/<file>, a wrong or nonexistent file - so it stays plain text until the
 * dependency's own pinned sha is threaded to this page.
 */
export function evidencePermalink(
  ref: { repo?: string; file?: string; lines?: string },
  repoFullName: string | undefined,
  commitSha: string | undefined,
): string | undefined {
  if (ref.repo != null) return undefined;
  return githubPermalink(repoFullName, commitSha, ref.file, ref.lines);
}

/** Turn an evidence line range ("451-470", "L58-67", "42") into a GitHub anchor ("#L451-L470", "#L42"). */
function lineAnchor(lines: string | undefined): string {
  if (lines == null) return "";
  const match = lines.match(/(\d+)(?:\s*-\s*L?(\d+))?/);
  if (match == null) return "";
  return match[2] != null ? `#L${match[1]}-L${match[2]}` : `#L${match[1]}`;
}
