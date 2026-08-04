import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@autonoma/blacklight";
import { useCreateApplication, useUploadPackage } from "lib/query/applications.queries";
import { useRef, useState } from "react";

type Architecture = "WEB" | "IOS" | "ANDROID";

const ARCHITECTURES: { value: Architecture; label: string }[] = [
  { value: "WEB", label: "Web" },
  { value: "IOS", label: "iOS" },
  { value: "ANDROID", label: "Android" },
];

const ACCEPTED_PACKAGE_EXTENSIONS = ".apk,.app,.ipa";

interface CreateApplicationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function buildCreateApplicationFormData(params: {
  name: string;
  architecture: Architecture;
  url: string;
  file: string;
  packageUrl: string;
  photo: string;
}): FormData {
  const formData = new FormData();

  const metadata: Record<string, string> = {
    name: params.name,
    architecture: params.architecture,
  };

  if (params.architecture === "WEB") {
    metadata.url = params.url;
    if (params.file.length > 0) metadata.file = params.file;
  } else {
    metadata.packageUrl = params.packageUrl;
    metadata.photo = params.photo;
  }

  formData.append("metadata", JSON.stringify(metadata));
  return formData;
}

export function CreateApplicationDialog({ open, onOpenChange }: CreateApplicationDialogProps) {
  const [name, setName] = useState("");
  const [architecture, setArchitecture] = useState<Architecture>("WEB");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState("");
  const [packageUrl, setPackageUrl] = useState("");
  const [photo, setPhoto] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const createApplication = useCreateApplication();
  const uploadPackage = useUploadPackage();

  function resetForm() {
    setName("");
    setArchitecture("WEB");
    setUrl("");
    setFile("");
    setPackageUrl("");
    setPhoto("");
    setSelectedFileName("");
    uploadPackage.reset();
    if (fileInputRef.current != null) {
      fileInputRef.current.value = "";
    }
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = e.target.files?.[0];
    if (selectedFile == null) return;

    setSelectedFileName(selectedFile.name);
    setPackageUrl("");

    uploadPackage.mutate(selectedFile, {
      onSuccess: (data) => {
        setPackageUrl(data.url);
      },
    });
  }

  function handleCreate() {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return;

    if (architecture === "WEB") {
      if (url.trim().length === 0) return;
    } else {
      if (packageUrl.length === 0 || photo.trim().length === 0) return;
    }

    const formData = buildCreateApplicationFormData({
      name: trimmedName,
      architecture,
      url: url.trim(),
      file: file.trim(),
      packageUrl,
      photo: photo.trim(),
    });

    createApplication.mutate(formData, {
      onSuccess: () => {
        onOpenChange(false);
        resetForm();
      },
    });
  }

  const isWeb = architecture === "WEB";
  const isUploading = uploadPackage.isPending;
  const isUploadFailed = uploadPackage.isError;
  const isValid =
    name.trim().length > 0 && (isWeb ? url.trim().length > 0 : packageUrl.length > 0 && photo.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New application</DialogTitle>
          <DialogDescription>Create a new application to start testing.</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
        >
          <DialogBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-app-name">Name</Label>
              <Input
                id="create-app-name"
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                placeholder="My application"
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Platform</Label>
              <div className="flex gap-2">
                {ARCHITECTURES.map(({ value, label }) => (
                  <Button
                    key={value}
                    type="button"
                    variant={architecture === value ? "default" : "outline"}
                    size="sm"
                    onClick={() => setArchitecture(value)}
                    aria-label={`create-application-select-platform-${value.toLowerCase()}`}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>

            {isWeb ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="create-app-url">URL</Label>
                  <Input
                    id="create-app-url"
                    value={url}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
                    placeholder="https://example.com"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="create-app-file">Upload file (S3 URI, optional)</Label>
                  <Input
                    id="create-app-file"
                    value={file}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFile(e.target.value)}
                    placeholder="s3://bucket/uploads/..."
                  />
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="create-app-package">Package file</Label>
                  <input
                    ref={fileInputRef}
                    id="create-app-package"
                    type="file"
                    accept={ACCEPTED_PACKAGE_EXTENSIONS}
                    onChange={handleFileSelected}
                    className="hidden"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploading}
                      aria-label="create-application-select-package"
                    >
                      {isUploading ? "Uploading..." : "Choose file"}
                    </Button>
                    <span className="text-text-secondary truncate text-sm">
                      {isUploading && selectedFileName}
                      {isUploadFailed && "Upload failed - try again"}
                      {!isUploading && !isUploadFailed && packageUrl.length > 0 && selectedFileName}
                      {!isUploading &&
                        !isUploadFailed &&
                        packageUrl.length === 0 &&
                        selectedFileName.length === 0 &&
                        "No file selected"}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="create-app-photo">Photo (S3 URI)</Label>
                  <Input
                    id="create-app-photo"
                    value={photo}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPhoto(e.target.value)}
                    placeholder="s3://bucket/uploads/..."
                  />
                </div>
              </>
            )}
          </DialogBody>
        </form>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" aria-label="create-application-cancel" />}>Cancel</DialogClose>
          <Button
            onClick={handleCreate}
            disabled={createApplication.isPending || isUploading || !isValid}
            aria-label="create-application-submit"
          >
            {createApplication.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
