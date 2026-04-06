import type { GithubHistory } from "./github-history";

export class FakeGithubHistory implements GithubHistory {
    private nextSha?: string;

    setNextSha(sha: string | undefined) {
        this.nextSha = sha;
    }

    async nextCommitOnBranch(_afterSha: string): Promise<string | undefined> {
        return this.nextSha;
    }

    async latestBetween(sha1: string, _sha2: string): Promise<string> {
        return sha1;
    }
}
