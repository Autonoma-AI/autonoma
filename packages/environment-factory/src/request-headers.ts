export function getHeaderValue(
    headers: Headers | Record<string, string | string[] | undefined>,
    headerName: string,
): string | undefined {
    if (headers instanceof Headers) {
        return headers.get(headerName) ?? undefined;
    }

    const expectedName = headerName.toLowerCase();

    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() !== expectedName) {
            continue;
        }

        if (Array.isArray(value)) {
            return value[0];
        }

        return value;
    }

    return undefined;
}
