/*
  Warnings:

  - Made the column `app_name` on table `previewkit_secret` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "previewkit_secret" ALTER COLUMN "app_name" SET NOT NULL;
