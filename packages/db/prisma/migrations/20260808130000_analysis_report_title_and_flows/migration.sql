-- The Reporter now authors the PR's title and its flow itemization alongside the headline.
-- The headline keeps the `summary` column it already had; only the Prisma field was renamed, so no data moves.
--
-- `title` is added WITH a default and then has it dropped: Postgres needs one to add a NOT NULL column to a
-- populated table, but keeping it would let a writer that forgets `title` silently persist '' - which every reader
-- takes to mean "no authored title". Without the default that writer fails loudly instead.
--
-- The 4842 reports that already exist keep the '' this leaves behind, and that is the ONLY thing '' means. They are
-- not backfilled: a derived title written into a column documented as the Reporter's would make authored and
-- derived indistinguishable to anything reading the table later, and the surfaces already derive that copy live
-- from each row's own counts. `analysisPrTitle` is the single reader of ''; when no live surface can reach a
-- pre-Reporter report, delete that branch and this comment together.
ALTER TABLE "analysis_report" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
ALTER TABLE "analysis_report" ALTER COLUMN "title" DROP DEFAULT;
ALTER TABLE "analysis_report" ADD COLUMN "flows" JSONB;
