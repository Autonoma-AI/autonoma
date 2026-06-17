import { Button, cn } from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DownloadSimpleIcon } from "@phosphor-icons/react/DownloadSimple";
import { toastManager } from "lib/toast-manager";
import { useState } from "react";

export interface YamlPreviewDocument {
  /** Repo label shown on the selector ("primary" shows the linked repo's name). */
  label: string;
  yaml: string;
}

interface YamlPreviewPanelProps {
  documents: YamlPreviewDocument[];
}

/**
 * Read-only `.preview.yaml` artifact generated from the structured form. With
 * dependency repos, each repo gets its own document (PreviewKit reads one
 * config per repo). Sticky on desktop; collapsible below `xl`.
 */
export function YamlPreviewPanel({ documents }: YamlPreviewPanelProps) {
  const [selectedLabel, setSelectedLabel] = useState(documents[0]?.label ?? "");
  const [expanded, setExpanded] = useState(false);

  const selected = documents.find((document) => document.label === selectedLabel) ?? documents[0];
  if (selected == null) return undefined;

  function copyYaml(yaml: string) {
    void navigator.clipboard.writeText(yaml).then(() => {
      toastManager.add({
        type: "success",
        title: ".preview.yaml copied",
        description: "Use it as the repo file when you want GitHub write-back later.",
      });
    });
  }

  function downloadYaml(yaml: string) {
    const blob = new Blob([yaml], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = ".preview.yaml";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="border border-border-dim bg-surface-base xl:sticky xl:top-20 xl:max-h-[calc(100vh-8rem)] xl:self-start">
      <div className="flex items-center justify-between gap-2 border-b border-border-dim bg-surface-raised px-5 py-4">
        <button
          type="button"
          className="flex items-center gap-2 xl:pointer-events-none"
          onClick={() => setExpanded((current) => !current)}
        >
          <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">.preview.yaml</h2>
          <CaretDownIcon size={14} className={cn("transition-transform xl:hidden", expanded && "rotate-180")} />
        </button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="xs" className="gap-2" onClick={() => downloadYaml(selected.yaml)}>
            <DownloadSimpleIcon size={13} />
            Download
          </Button>
          <Button variant="outline" size="xs" className="gap-2" onClick={() => copyYaml(selected.yaml)}>
            <CopyIcon size={13} />
            Copy
          </Button>
        </div>
      </div>

      {documents.length > 1 ? (
        <div className="flex flex-wrap gap-2 border-b border-border-dim px-5 py-3">
          {documents.map((document) => (
            <Button
              key={document.label}
              variant={document.label === selected.label ? "accent" : "outline"}
              size="xs"
              className="max-w-48 truncate font-mono"
              onClick={() => setSelectedLabel(document.label)}
            >
              {document.label}
            </Button>
          ))}
        </div>
      ) : undefined}

      <pre
        className={cn(
          "max-h-[40rem] overflow-auto p-6 font-mono text-sm leading-relaxed text-text-primary",
          expanded ? "block" : "hidden xl:block",
        )}
      >
        {selected.yaml}
      </pre>
    </section>
  );
}
