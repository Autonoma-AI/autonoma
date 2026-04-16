/*
  Warnings:

  - A unique constraint covering the columns `[application_id,parent_id,name]` on the table `folder` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "folder_application_id_parent_id_name_key" ON "folder"("application_id", "parent_id", "name");
