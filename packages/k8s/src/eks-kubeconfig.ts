import { logger as rootLogger, type Logger } from "@autonoma/logger";
import { Sha256 } from "@aws-crypto/sha256-js";
import { DescribeClusterCommand, EKSClient } from "@aws-sdk/client-eks";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import * as k8s from "@kubernetes/client-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

// STS presigned URLs for EKS auth expire in 60 seconds. Cache ordinary callers
// for 50 seconds, while the background refresher uses refresh() to mint early.
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

interface EksKubeconfigLoaderDependencies {
    now?: () => number;
    tokenFactory?: () => Promise<string>;
}

/**
 * Builds a `KubeConfig` for an EKS cluster authenticated with a short-lived
 * STS-presigned token (the same handshake `aws eks get-token` performs). Used
 * for CROSS-cluster access - a pod in one cluster reaching another's API server
 * (the preview cluster) where in-cluster credentials do not apply. Same-cluster
 * callers should use `KubeConfig.loadFromCluster()` instead.
 */
export class EksKubeconfigLoader {
    private readonly logger: Logger;
    private readonly eksClient: EKSClient;
    private readonly signer: SignatureV4;
    private clusterInfo?: CachedClusterInfo;
    private cachedKubeconfig?: k8s.KubeConfig;
    private cachedAt?: number;
    private readonly now: () => number;
    private readonly tokenFactory?: () => Promise<string>;

    constructor(
        private readonly clusterName: string,
        private readonly region: string,
        staticClusterInfo?: { endpoint: string; caData: string },
        dependencies?: EksKubeconfigLoaderDependencies,
    ) {
        this.logger = rootLogger.child({ name: "EksKubeconfigLoader", cluster: clusterName });
        this.eksClient = new EKSClient({ region });
        this.signer = new SignatureV4({
            credentials: defaultProvider(),
            region,
            service: "sts",
            sha256: Sha256,
        });
        this.now = dependencies?.now ?? Date.now;
        this.tokenFactory = dependencies?.tokenFactory;

        if (staticClusterInfo != null) {
            this.clusterInfo = staticClusterInfo;
        }
    }

    async load(): Promise<k8s.KubeConfig> {
        const now = this.now();
        const needsRefresh = this.cachedAt == null || now - this.cachedAt >= CACHE_TTL_MS;

        if (!needsRefresh && this.cachedKubeconfig != null) {
            return this.cachedKubeconfig;
        }

        return await this.reload(now);
    }

    /**
     * Mints a token regardless of cache age. The periodic refresher calls this
     * before the current 60-second token can expire.
     */
    async refresh(): Promise<k8s.KubeConfig> {
        this.logger.debug("Refreshing EKS kubeconfig token");
        const kubeconfig = await this.reload(this.now());
        this.logger.debug("Refreshed EKS kubeconfig token");
        return kubeconfig;
    }

    private async reload(now: number): Promise<k8s.KubeConfig> {
        const [cluster, token] = await Promise.all([this.describeCluster(), this.mintToken()]);

        if (this.cachedKubeconfig == null) {
            this.cachedKubeconfig = new k8s.KubeConfig();
        }

        // "eks-sts" is a LOCAL handle only - it names the user block so the
        // context can reference it. It has no bearing on RBAC or permissions:
        // the identity Kubernetes authorizes comes entirely from the STS token
        // (the IAM principal, mapped via the cluster's access entry). Any string
        // works as long as users[].name and contexts[].user match.
        const USER_HANDLE = "eks-sts";
        // loadFromOptions replaces kc.users on the same object reference.
        // API clients that hold a reference to this kc call applyToFetchOptions per request,
        // which re-reads kc.users, so they pick up the fresh token automatically.
        this.cachedKubeconfig.loadFromOptions({
            clusters: [
                { name: this.clusterName, server: cluster.endpoint, caData: cluster.caData, skipTLSVerify: false },
            ],
            users: [{ name: USER_HANDLE, token }],
            contexts: [{ name: this.clusterName, user: USER_HANDLE, cluster: this.clusterName }],
            currentContext: this.clusterName,
        });

        this.cachedAt = now;
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
        if (this.tokenFactory != null) return await this.tokenFactory();

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

        // signed.query is a QueryParameterBag: string | string[] | null per key.
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(signed.query ?? {})) {
            if (value == null) continue;
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
