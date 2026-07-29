-- CreateTable
CREATE TABLE "previewkit_secret_value" (
    "id" TEXT NOT NULL,
    "secret_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "envelope" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "masked_length" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "previewkit_secret_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "previewkit_org_secret_value" (
    "id" TEXT NOT NULL,
    "org_secret_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "envelope" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "masked_length" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "previewkit_org_secret_value_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "previewkit_secret_value_generation_id_idx" ON "previewkit_secret_value"("generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_secret_value_secret_id_key_key" ON "previewkit_secret_value"("secret_id", "key");

-- CreateIndex
CREATE INDEX "previewkit_org_secret_value_generation_id_idx" ON "previewkit_org_secret_value"("generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_org_secret_value_org_secret_id_key_key" ON "previewkit_org_secret_value"("org_secret_id", "key");

-- AddForeignKey
ALTER TABLE "previewkit_secret_value" ADD CONSTRAINT "previewkit_secret_value_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "previewkit_secret"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previewkit_secret_value" ADD CONSTRAINT "previewkit_secret_value_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "previewkit_secret_key"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previewkit_org_secret_value" ADD CONSTRAINT "previewkit_org_secret_value_org_secret_id_fkey" FOREIGN KEY ("org_secret_id") REFERENCES "previewkit_org_secret"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previewkit_org_secret_value" ADD CONSTRAINT "previewkit_org_secret_value_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "previewkit_secret_key"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
