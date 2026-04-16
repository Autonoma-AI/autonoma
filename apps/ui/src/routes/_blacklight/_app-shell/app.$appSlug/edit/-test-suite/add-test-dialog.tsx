import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@autonoma/blacklight";
import { UploadSimpleIcon } from "@phosphor-icons/react/UploadSimple";
import { XIcon } from "@phosphor-icons/react/X";
import { useFolders } from "lib/query/folders.queries";
import { useScenariosForApp } from "lib/query/scenarios.queries";
import { useAddTestToEdit, useAddTestsToEdit } from "lib/query/snapshot-edit.queries";
import { Suspense, useRef, useState } from "react";
import { useCurrentApplication } from "../../../-use-current-application";

interface AddTestDialogProps {
  branchId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddTestDialog({ branchId, open, onOpenChange }: AddTestDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add test</DialogTitle>
          <DialogDescription>Add a new test to the snapshot being edited.</DialogDescription>
        </DialogHeader>
        <Suspense fallback={<Skeleton className="mx-6 mb-6 h-64 w-auto" />}>
          <AddTestFormContent branchId={branchId} onClose={() => onOpenChange(false)} />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}

// ─── Form ────────────────────────────────────────────────────────────────────

const NO_SCENARIO_VALUE = "__none__";
type AddTab = "text" | "upload";

function AddTestFormContent({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const currentApp = useCurrentApplication();
  const { data: scenarios } = useScenariosForApp(currentApp.id);
  const { data: folders } = useFolders();

  const [activeTab, setActiveTab] = useState<AddTab>("text");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [scenarioId, setScenarioId] = useState("");
  const [folderId, setFolderId] = useState(folders[0]?.id ?? "");
  const [files, setFiles] = useState<File[]>([]);

  const addTest = useAddTestToEdit();
  const addTests = useAddTestsToEdit();
  const isSubmitting = addTest.isPending || addTests.isPending;

  function resetForm() {
    setName("");
    setText("");
    setFiles([]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const selectedScenarioId = scenarioId !== "" ? scenarioId : undefined;

    if (activeTab === "text") {
      addTest.mutate(
        { branchId, name, plan: text, folderId, scenarioId: selectedScenarioId },
        {
          onSuccess: () => {
            resetForm();
            onClose();
          },
        },
      );
    } else {
      const tests = await Promise.all(
        files.map(async (file) => ({
          name: file.name.replace(/\.(md|markdown)$/i, ""),
          plan: await file.text(),
          folderId,
        })),
      );
      addTests.mutate(
        { branchId, tests, scenarioId: selectedScenarioId },
        {
          onSuccess: () => {
            resetForm();
            onClose();
          },
        },
      );
    }
  }

  const hasFolderId = folderId !== "";
  const isTextValid = name.trim() !== "" && text.trim() !== "" && hasFolderId;
  const isUploadValid = files.length > 0 && hasFolderId;
  const isValid = activeTab === "text" ? isTextValid : isUploadValid;

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      <DialogBody className="flex flex-col gap-4">
        {folders.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label>Folder</Label>
            <Select<string> value={folderId} onValueChange={(value) => setFolderId(value ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue>{folders.find((f) => f.id === folderId)?.name}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {folders.map((folder) => (
                  <SelectItem key={folder.id} value={folder.id}>
                    {folder.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {scenarios != null && scenarios.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label>Scenario</Label>
            <Select<string>
              value={scenarioId === "" ? NO_SCENARIO_VALUE : scenarioId}
              onValueChange={(value) => {
                setScenarioId(value === NO_SCENARIO_VALUE || value == null ? "" : value);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SCENARIO_VALUE}>None</SelectItem>
                {scenarios.map((scenario) => (
                  <SelectItem key={scenario.id} value={scenario.id}>
                    {scenario.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Tabs value={activeTab} onValueChange={(v: string) => setActiveTab(v as AddTab)}>
          <TabsList>
            <TabsTrigger value="text">Text</TabsTrigger>
            <TabsTrigger value="upload">Upload files</TabsTrigger>
          </TabsList>

          <TabsContent value="text" className="mt-3 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-test-name">
                Name <span className="text-status-critical">*</span>
              </Label>
              <Input
                id="add-test-name"
                placeholder="My test plan"
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-test-plan">
                Plan <span className="text-status-critical">*</span>
              </Label>
              <Textarea
                id="add-test-plan"
                placeholder="Write your test plan in markdown..."
                value={text}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
                className="min-h-32 resize-none"
              />
            </div>
          </TabsContent>

          <TabsContent value="upload" className="mt-3">
            <MarkdownFileInput files={files} onChange={setFiles} />
          </TabsContent>
        </Tabs>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!isValid || isSubmitting} size="sm">
          {isSubmitting
            ? "Adding..."
            : activeTab === "upload" && files.length > 1
              ? `Add ${files.length} tests`
              : "Add test"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ─── Markdown File Input ─────────────────────────────────────────────────────

function MarkdownFileInput({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    if (selected.length === 0) return;
    const existingNames = new Set(files.map((f) => f.name));
    onChange([...files, ...selected.filter((f) => !existingNames.has(f.name))]);
    e.target.value = "";
  }

  function remove(index: number) {
    onChange(files.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".md,.markdown,text/markdown"
        className="sr-only"
        onChange={handleChange}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex h-9 w-full items-center gap-2 border border-dashed border-border-mid bg-transparent px-3 font-mono text-2xs text-text-secondary transition-colors hover:border-border-highlight hover:text-text-primary"
      >
        <UploadSimpleIcon size={14} className="shrink-0" />
        {files.length === 0 ? "Upload markdown files" : "Add more files"}
      </button>
      {files.length > 0 && (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
          {files.map((file, i) => (
            <li
              key={file.name}
              className="flex items-center gap-2 border border-border-dim bg-surface-base px-3 py-1.5 font-mono text-2xs text-text-secondary"
            >
              <span className="flex-1 truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => remove(i)}
                className="shrink-0 text-text-tertiary transition-colors hover:text-text-primary"
              >
                <XIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
