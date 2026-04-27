import { Sha256 } from "@aws-crypto/sha256-js";
import { DescribeClusterCommand, EKSClient } from "@aws-sdk/client-eks";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import * as k8s from "@kubernetes/client-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { logger as rootLogger } from "../logger";

const CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedClusterInfo {
    endpoint: string;
    caData: string;
}

export interface EksKubeconfigLoaderOptions {
    clusterName: string;
    region: string;
}

export class EksKubeconfigLoader {
    private readonly logger = rootLogger.child({ name: "EksKubeconfigLoader", cluster: this.clusterName });
    private readonly eksClient: EKSClient;
    private readonly signer: SignatureV4;
    private clusterInfo?: CachedClusterInfo;
    private cachedKubeconfig?: k8s.KubeConfig;
    private cachedAt?: number;

    constructor(
        private readonly clusterName: string,
        private readonly region: string,
    ) {
        this.eksClient = new EKSClient({ region });
        this.signer = new SignatureV4({
            credentials: defaultProvider(),
            region,
            service: "sts",
            sha256: Sha256,
        });
    }

    async load(): Promise<k8s.KubeConfig> {
        if (this.cachedKubeconfig != null && this.cachedAt != null) {
            const age = Date.now() - this.cachedAt;
            if (age < CACHE_TTL_MS) {
                return this.cachedKubeconfig;
            }
        }

        const cluster = await this.describeCluster();
        const token = await this.mintToken();

        const kc = new k8s.KubeConfig();
        kc.loadFromOptions({
            clusters: [
                {
                    name: this.clusterName,
                    server: cluster.endpoint,
                    caData: cluster.caData,
                    skipTLSVerify: false,
                },
            ],
            users: [{ name: "previewkit", token }],
            contexts: [
                {
                    name: this.clusterName,
                    user: "previewkit",
                    cluster: this.clusterName,
                },
            ],
            currentContext: this.clusterName,
        });

        this.cachedKubeconfig = kc;
        this.cachedAt = Date.now();
        this.logger.info("Minted EKS kubeconfig", { cachedAt: new Date(this.cachedAt).toISOString() });
        return kc;
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
