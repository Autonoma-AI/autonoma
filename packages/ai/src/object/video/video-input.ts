/** The different ways to provide video data for AI generation */
type VideoData = { type: "buffer"; buffer: ArrayBuffer } | { type: "file"; path: string };

export interface VideoInput {
    /** The contents of the video */
    data: VideoData;
    /** The MIME type of the video */
    mimeType: "video/mp4" | "video/webm";
}
