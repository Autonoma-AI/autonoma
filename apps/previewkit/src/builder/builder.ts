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
}

export interface Builder {
    build(request: BuildRequest): Promise<BuildResult>;
}
