import { ApiException } from "@kubernetes/client-node";

export function isConflict(err: unknown): boolean {
    return err instanceof ApiException && err.code === 409;
}

export function isNotFound(err: unknown): boolean {
    return err instanceof ApiException && err.code === 404;
}
