/**
 * Dev harness: render the investigation PR comment through the SHARED renderer, from a REAL report JSON, so the
 * markdown can be eyeballed and piped onto a real PR for design review. NOT shipped.
 *
 *   REPORT_JSON=/path/to/<snap>.json SNAPSHOT_ID=<snap> DATABASE_URL=postgres://x \
 *     S3_BUCKET=... S3_REGION=us-east-1 S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *     tsx scripts/preview-pr-comment.ts | gh pr comment <pr> --body-file -
 *
 * Tweak packages/github/src/comment/markdown.ts and re-run to see the layout.
 */
import { readFileSync } from "node:fs";
import { type AutonomaCommentBug, type AutonomaCommentPayload, renderMarkdown } from "@autonoma/github/comment";
import { S3Storage } from "@autonoma/storage";
import type { InvestigationFinding, InvestigationReportData } from "@autonoma/types";

const reportPath = process.env.REPORT_JSON;
if (reportPath == null) throw new Error("set REPORT_JSON to a report .json path");
const snapshotId = process.env.SNAPSHOT_ID ?? "";
const data: InvestigationReportData = JSON.parse(readFileSync(reportPath, "utf8"));

const APP = "https://beta.autonoma.app";
const reportBase = `${APP}/app/${data.appSlug}/pull-requests/${data.prNumber}/snapshots/${snapshotId}/investigation`;
const storage = S3Storage.createFromEnv();

/** Sign an s3:// screenshot key as image/png so GitHub (camo) renders it - the objects are stored octet-stream. */
async function sign(s3Url: string | undefined): Promise<string | undefined> {
    if (s3Url == null || !s3Url.startsWith("s3://")) return undefined;
    return storage.getSignedUrl(s3Url, 7 * 24 * 60 * 60, "image/png");
}

const clientBugs = data.findings.filter((finding) => finding.category === "client_bug");
const bugs: AutonomaCommentBug[] = await Promise.all(
    clientBugs.map(async (finding: InvestigationFinding) => ({
        title: finding.headline,
        href: `${reportBase}/${finding.id}`,
        replayHref: `${reportBase}/${finding.id}`,
        screenshotUrl: await sign(finding.finalScreenshotUrl),
        description: finding.whatHappened,
        remediation: finding.remediation,
        evidence: finding.evidence.map((item) => ({
            source: item.source,
            detail: item.detail,
            file: item.file,
            lines: item.lines,
            snippet: item.snippet,
        })),
    })),
);

const payload: AutonomaCommentPayload = {
    state: bugs.length > 0 ? "critical" : "healthy",
    prNumber: data.prNumber,
    headline: "",
    commitRef: (data.commitSha ?? "").slice(0, 7),
    assetBaseUrl: `${APP}/github-comment/`,
    ctas: [
        { label: "Open in Autonoma", href: reportBase },
        { label: "See preview", href: process.env.PREVIEW_URL ?? reportBase },
    ],
    services: [],
    warnings: [],
    details: [],
    bugs,
};

console.log(renderMarkdown(payload));
