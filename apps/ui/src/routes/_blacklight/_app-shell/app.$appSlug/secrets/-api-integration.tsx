import {
  Button,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@autonoma/blacklight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { env } from "env";
import { toastManager } from "lib/toast-manager";
import { useState } from "react";
import { Highlight } from "./-highlight";

interface ApiIntegrationProps {
  applicationId: string;
}

type Operation = "list" | "set" | "delete";

const BASE_URL = env.VITE_API_URL;

const OPERATIONS: {
  value: Operation;
  label: string;
  method: "GET" | "PUT" | "DELETE";
  path: (appId: string) => string;
}[] = [
  { value: "list", label: "List", method: "GET", path: (id) => `/v1/applications/${id}/secrets` },
  { value: "set", label: "Set", method: "PUT", path: (id) => `/v1/applications/${id}/secrets/{key}` },
  { value: "delete", label: "Delete", method: "DELETE", path: (id) => `/v1/applications/${id}/secrets/{key}` },
];

function buildCurl(op: Operation, appId: string): string {
  const base = `curl -H "Authorization: Bearer $AUTONOMA_API_KEY"`;
  switch (op) {
    case "list":
      return `${base} \\\n  ${BASE_URL}/v1/applications/${appId}/secrets`;
    case "set":
      return `${base} \\\n  -X PUT \\\n  -H "Content-Type: application/json" \\\n  -d '{"value": "sk_live_..."}' \\\n  ${BASE_URL}/v1/applications/${appId}/secrets/STRIPE_SECRET_KEY`;
    case "delete":
      return `${base} \\\n  -X DELETE \\\n  ${BASE_URL}/v1/applications/${appId}/secrets/STRIPE_SECRET_KEY`;
  }
}

function buildNode(op: Operation, appId: string): string {
  const init = `const API = "${BASE_URL}/v1/applications/${appId}/secrets";
const headers = { Authorization: \`Bearer \${process.env.AUTONOMA_API_KEY}\` };`;
  switch (op) {
    case "list":
      return `${init}

const res = await fetch(API, { headers });
const { keys } = await res.json();`;
    case "set":
      return `${init}

await fetch(\`\${API}/STRIPE_SECRET_KEY\`, {
  method: "PUT",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ value: "sk_live_..." }),
});`;
    case "delete":
      return `${init}

await fetch(\`\${API}/STRIPE_SECRET_KEY\`, {
  method: "DELETE",
  headers,
});`;
  }
}

const METHOD_STYLES: Record<string, string> = {
  GET: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  PUT: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  DELETE: "bg-status-critical/10 text-status-critical border-status-critical/20",
};

export function ApiIntegration({ applicationId }: ApiIntegrationProps) {
  const [op, setOp] = useState<Operation>("list");
  const current = OPERATIONS.find((o) => o.value === op) ?? OPERATIONS[0]!;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-secondary">
        Fetch, rotate, and remove secrets at runtime. Authenticate with an{" "}
        <span className="text-text-primary">Autonoma API key</span> — never commit the key itself.
      </p>

      <Tabs value={op} onValueChange={(v) => setOp(v as Operation)}>
        <TabsList className="w-full">
          {OPERATIONS.map((o) => (
            <TabsTrigger key={o.value} value={o.value} className="flex-1">
              {o.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {OPERATIONS.map((o) => (
          <TabsContent key={o.value} value={o.value} className="mt-3 flex flex-col gap-3">
            <div className="flex items-center gap-2 overflow-x-auto rounded-md border border-border-dim bg-surface-base px-3 py-2">
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-3xs font-semibold ${METHOD_STYLES[o.method] ?? ""}`}
              >
                {o.method}
              </span>
              <code className="truncate font-mono text-xs text-text-primary">{o.path(applicationId)}</code>
            </div>
            <CodeBlock title="cURL" language="bash" code={buildCurl(o.value, applicationId)} />
            <CodeBlock title="Node.js" language="javascript" code={buildNode(o.value, applicationId)} />
          </TabsContent>
        ))}
      </Tabs>

      <p className="font-mono text-3xs text-text-tertiary">
        Base URL <span className="text-text-secondary">{BASE_URL}</span> — currently {current.method}{" "}
        {current.path(applicationId)}
      </p>
      <p className="font-mono text-3xs text-text-tertiary">
        Values are write-only and cannot be read back via the API. Use <span className="text-text-secondary">PUT</span>{" "}
        to rotate.
      </p>
    </div>
  );
}

function CodeBlock({ title, language, code }: { title: string; language: "bash" | "javascript"; code: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      toastManager.add({
        title: "Copy failed",
        description: "Clipboard is unavailable in this context.",
        type: "critical",
      });
      return;
    }
    setCopied(true);
    toastManager.add({ title: "Snippet copied", description: title, type: "success" });
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="overflow-hidden rounded-md border border-border-dim bg-surface-base">
      <div className="flex items-center justify-between border-b border-border-dim px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">{title}</span>
          <span className="font-mono text-3xs text-text-tertiary">{language}</span>
        </div>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="xs" className="gap-1.5" onClick={handleCopy} />}>
            {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            {copied ? "Copied" : "Copy"}
          </TooltipTrigger>
          <TooltipContent>Copy snippet</TooltipContent>
        </Tooltip>
      </div>
      <pre className="overflow-x-auto px-3 py-3 font-mono text-xs text-text-primary">
        <code>
          <Highlight code={code} language={language} />
        </code>
      </pre>
    </div>
  );
}
