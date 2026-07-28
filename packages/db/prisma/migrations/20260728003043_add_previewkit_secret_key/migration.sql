-- CreateTable
CREATE TABLE "previewkit_secret_key" (
    "key_id" TEXT NOT NULL,
    "wrapped_key" BYTEA NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "previewkit_secret_key_pkey" PRIMARY KEY ("key_id")
);

-- CreateIndex
CREATE INDEX "previewkit_secret_key_is_primary_idx" ON "previewkit_secret_key"("is_primary");
