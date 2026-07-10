-- CreateTable
CREATE TABLE "jwks" (
    "id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "private_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "jwks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_application" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "metadata" TEXT,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT,
    "redirect_urls" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "disabled" BOOLEAN DEFAULT false,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_access_token" (
    "id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "access_token_expires_at" TIMESTAMP(3) NOT NULL,
    "refresh_token_expires_at" TIMESTAMP(3) NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT,
    "scopes" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_access_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_consent" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "consent_given" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_consent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_application_client_id_key" ON "oauth_application"("client_id");

-- CreateIndex
CREATE INDEX "oauth_application_user_id_idx" ON "oauth_application"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_access_token_access_token_key" ON "oauth_access_token"("access_token");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_access_token_refresh_token_key" ON "oauth_access_token"("refresh_token");

-- CreateIndex
CREATE INDEX "oauth_access_token_client_id_idx" ON "oauth_access_token"("client_id");

-- CreateIndex
CREATE INDEX "oauth_access_token_user_id_idx" ON "oauth_access_token"("user_id");

-- CreateIndex
CREATE INDEX "oauth_consent_client_id_idx" ON "oauth_consent"("client_id");

-- CreateIndex
CREATE INDEX "oauth_consent_user_id_idx" ON "oauth_consent"("user_id");

-- AddForeignKey
ALTER TABLE "oauth_application" ADD CONSTRAINT "oauth_application_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_application"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_application"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

