import { Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import { FileTextIcon } from "@phosphor-icons/react/FileText";

export function PRBodyCard({ body, authorLogin }: { body: string | undefined; authorLogin: string | undefined }) {
  if (body == null || body.trim().length === 0) return null;

  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <FileTextIcon size={14} className="text-text-tertiary" />
        <PanelTitle>{authorLogin != null ? `${authorLogin} commented` : "Description"}</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">{body}</p>
      </PanelBody>
    </Panel>
  );
}
