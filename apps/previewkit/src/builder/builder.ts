export interface BuildRequest {
    appName: string;
    contextPath: string;
    dockerfile?: string;
    buildArgs: Record<string, string>;
    imageTag: string;
}

export interface BuildResult {
    imageTag: string;
    durationMs: number;
    // S3 URL (`s3://bucket/key`) where the combined stdout+stderr log for this
    // build was uploaded. Always present on success; a successful build whose
    // log upload fails throws instead of returning a BuildResult. (Failed
    // builds throw and surface the URL via the error message when the log was
    // uploaded, or note the upload failure on the error otherwise.)
    logUrl: string;
}

export interface Builder {
    build(request: BuildRequest): Promise<BuildResult>;
}
