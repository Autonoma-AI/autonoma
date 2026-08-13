// A placeholder wrapped in the punctuation conventions documentation uses for one:
// <token>, {{token}}, [token], ${TOKEN}.
const WRAPPED_PLACEHOLDER = /^(<.+>|\{\{.+\}\}|\[.+\]|\$\{.+\})$/;

// A placeholder written as words rather than punctuation: YOUR_API_TOKEN,
// paste-your-key, replace_me, example_token, xxxxxx.
const PLACEHOLDER_WORDING = /^(your|paste|replace|insert|example|placeholder|xxx)[-_a-z0-9]*$/i;

/**
 * True when a credential is a documentation stand-in rather than a credential.
 *
 * Docs render a token as something the reader replaces, and both humans and
 * agents paste the example verbatim. The value then reaches us looking real
 * enough to run on, and every request 401s - which surfaces as a fatal agent
 * error carrying no message at all, because the provider SDK falls back to an
 * HTTP status text that is empty over HTTP/2. Recognizing one up front is the
 * difference between "your token is a placeholder" and an unexplained failure
 * the user retries until they give up.
 *
 * The first test is the load-bearing one: no credential we mint is punctuation
 * only, so `...`, `…`, `••••` and `----` are caught without enumerating the
 * stand-ins any particular page happens to use. The other two cover the written
 * conventions, which no `ask_`-prefixed or hex key can collide with.
 */
export function isPlaceholderCredential(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed === "") return true;
    if (!/[a-z0-9]/i.test(trimmed)) return true;
    if (WRAPPED_PLACEHOLDER.test(trimmed)) return true;
    return PLACEHOLDER_WORDING.test(trimmed);
}
