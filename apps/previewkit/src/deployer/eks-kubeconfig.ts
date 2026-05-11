import { Sha256 } from "@aws-crypto/sha256-js";
import { DescribeClusterCommand, EKSClient } from "@aws-sdk/client-eks";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import * as k8s from "@kubernetes/client-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { logger as rootLogger, type Logger } from "../logger";

// STS presigned URLs for EKS auth expire in 60 seconds — refresh at 50s to stay ahead.
const CACHE_TTL_MS = 50 * 1000;

interface CachedClusterInfo {
    endpoint: string;
    caData: string;
}

export interface EksKubeconfigLoaderOptions {
    clusterName: string;
    region: string;
    clusterEndpoint?: string;
    clusterCa?: string;
}

export class EksKubeconfigLoader {
    private readonly logger: Logger;
    private readonly eksClient: EKSClient;
    private readonly signer: SignatureV4;
    private clusterInfo?: CachedClusterInfo;
    private cachedKubeconfig?: k8s.KubeConfig;
    private cachedAt?: number;

    constructor(
        private readonly clusterName: string,
        private readonly region: string,
        staticClusterInfo?: { endpoint: string; caData: string },
    ) {
        this.logger = rootLogger.child({ name: "EksKubeconfigLoader", cluster: clusterName });
        this.eksClient = new EKSClient({ region });
        this.signer = new SignatureV4({
            credentials: defaultProvider(),
            region,
            service: "sts",
            sha256: Sha256,
        });

        if (staticClusterInfo != null) {
            this.clusterInfo = staticClusterInfo;
        }
    }

    async load(): Promise<k8s.KubeConfig> {
        const now = Date.now();
        const needsRefresh = this.cachedAt == null || now - this.cachedAt >= CACHE_TTL_MS;

        if (!needsRefresh && this.cachedKubeconfig != null) {
            return this.cachedKubeconfig;
        }

        const cluster = await this.describeCluster();
        const token = await this.mintToken();

        if (this.cachedKubeconfig == null) {
            this.cachedKubeconfig = new k8s.KubeConfig();
        }

        // loadFromOptions replaces kc.users on the same object reference.
        // API clients that hold a reference to this kc call applyToFetchOptions per request,
        // which re-reads kc.users, so they pick up the fresh token automatically.
        this.cachedKubeconfig.loadFromOptions({
            clusters: [
                { name: this.clusterName, server: cluster.endpoint, caData: cluster.caData, skipTLSVerify: false },
            ],
            users: [{ name: "previewkit", token }],
            contexts: [{ name: this.clusterName, user: "previewkit", cluster: this.clusterName }],
            currentContext: this.clusterName,
        });

        this.cachedAt = now;
        this.logger.info("Minted EKS kubeconfig", { cachedAt: new Date(this.cachedAt).toISOString() });
        return this.cachedKubeconfig;
    }

    private async describeCluster(): Promise<CachedClusterInfo> {
        if (this.clusterInfo != null) return this.clusterInfo;

        this.logger.info("Describing EKS cluster");
        const { cluster } = await this.eksClient.send(new DescribeClusterCommand({ name: this.clusterName }));
        if (cluster?.endpoint == null || cluster.certificateAuthority?.data == null) {
            throw new Error(`EKS cluster ${this.clusterName} missing endpoint or CA data`);
        }

        this.clusterInfo = {
            endpoint: cluster.endpoint,
            caData: cluster.certificateAuthority.data,
        };
        return this.clusterInfo;
    }

    private async mintToken(): Promise<string> {
        const hostname = `sts.${this.region}.amazonaws.com`;
        const request = new HttpRequest({
            method: "GET",
            protocol: "https:",
            hostname,
            path: "/",
            query: {
                Action: "GetCallerIdentity",
                Version: "2011-06-15",
            },
            headers: {
                host: hostname,
                "x-k8s-aws-id": this.clusterName,
            },
        });

        const signed = await this.signer.presign(request, {
            expiresIn: 60,
            signingDate: new Date(),
            unsignableHeaders: new Set(),
            signableHeaders: new Set(["host", "x-k8s-aws-id"]),
        });

        const query = signed.query as Record<string, string | string[]>;
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (Array.isArray(value)) {
                for (const v of value) params.append(key, v);
            } else {
                params.append(key, value);
            }
        }

        const presignedUrl = `https://${hostname}${signed.path}?${params.toString()}`;
        return `k8s-aws-v1.${Buffer.from(presignedUrl).toString("base64url")}`;
    }
}
