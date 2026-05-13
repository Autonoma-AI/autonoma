-- CreateTable
CREATE TABLE "previewkit_secret" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "aws_secret_arn" TEXT NOT NULL,
    "k8s_secret_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "previewkit_secret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_secret_application_id_key" ON "previewkit_secret"("application_id");

-- AddForeignKey
ALTER TABLE "previewkit_secret" ADD CONSTRAINT "previewkit_secret_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
