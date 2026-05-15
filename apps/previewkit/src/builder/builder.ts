export interface BuildRequest {
    appName: string;
    contextPath: string;
    dockerfile?: string;
    buildArgs: Record<string, string>;
    imageTag: string;
    cacheKey: string;
}

export interface BuildResult {
    imageTag: string;
    durationMs: number;
    logUrl: string;
}

export interface Builder {
    build(request: BuildRequest): Promise<BuildResult>;
}
