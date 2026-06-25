import { isReservedPreviewkitEnvKey } from "./schemas/previewkit-builtins";

/**
 * Heuristic classifier that decides whether an environment variable looks
 * sensitive (a secret) and should therefore be stored securely rather than as
 * plaintext config. It is intentionally a layered set of cheap, deterministic
 * rules - NOT a guarantee. The UI uses it to auto-check a "sensitive" toggle the
 * user can always override; never rely on it as the sole security boundary.
 *
 * Precedence (first match wins):
 *   1. Empty / template references (`{{...}}`) / reserved built-ins -> not sensitive.
 *   2. Public-prefixed keys (`NEXT_PUBLIC_`, `VITE_`, ...) -> only egregious
 *      value patterns (e.g. a literal private key) flag them.
 *   3. Known secret value patterns (private keys, provider tokens, JWTs,
 *      credentialed connection strings) -> sensitive (high confidence).
 *   4. Sensitive-looking key names (`*_SECRET`, `*_TOKEN`, `*_PASSWORD`, ...) -> sensitive.
 *   5. High Shannon entropy + token-shaped value -> sensitive (medium confidence).
 */
export interface SensitiveDetection {
    sensitive: boolean;
    reason?: "value-pattern" | "key-name" | "entropy";
    confidence: "low" | "medium" | "high";
}

const NOT_SENSITIVE: SensitiveDetection = { sensitive: false, confidence: "low" };

// Key-name tokens that strongly imply a secret. Matched case-insensitively and
// only on `_`/boundary edges so e.g. `BETTER_AUTH_URL` does not trip on a bare
// "AUTH" and `API_NODE_ENDPOINT` does not trip on "API_KEY".
const SENSITIVE_KEY_TOKENS = [
    "SECRET",
    "SECRETS",
    "SECRET_KEY",
    "SECRET_ACCESS_KEY",
    "CLIENT_SECRET",
    "SIGNING_SECRET",
    "SESSION_SECRET",
    "TOKEN",
    "ACCESS_TOKEN",
    "AUTH_TOKEN",
    "REFRESH_TOKEN",
    "API_TOKEN",
    "PASSWORD",
    "PASSWD",
    "PWD",
    "PASSPHRASE",
    "API_KEY",
    "APIKEY",
    "ACCESS_KEY",
    "PRIVATE_KEY",
    "ENCRYPTION_KEY",
    "SIGNING_KEY",
    "CREDENTIAL",
    "CREDENTIALS",
    "DSN",
    "SALT",
];

const SENSITIVE_KEY_REGEX = new RegExp(`(?:^|_)(?:${SENSITIVE_KEY_TOKENS.join("|")})(?:_|$)`, "i");
const PUBLIC_KEY_PREFIX_REGEX = /^(?:NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|PUBLIC_)/i;
const PUBLIC_KEY_TOKEN_REGEX = /(?:^|_)PUBLIC(?:_|$)/i;

// Known secret value shapes. Kept deliberately specific so we don't flag plain
// URLs, UUIDs, or config blobs by pattern alone.
const VALUE_PATTERNS: RegExp[] = [
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, // PEM private key
    /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
    /\bASIA[0-9A-Z]{16}\b/, // AWS temporary access key id
    /\bsk_(?:live|test)_[0-9a-zA-Z]{16,}\b/, // Stripe secret key
    /\brk_(?:live|test)_[0-9a-zA-Z]{16,}\b/, // Stripe restricted key
    /\bgh[posru]_[A-Za-z0-9]{30,}\b/, // GitHub token
    /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, // Slack token
    /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
    /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style key
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, // JWT
    // Credentialed connection string: any `scheme://user:password@host`, including
    // wrapped forms like `jdbc:postgresql://user:pass@host`. A plain URL (no inline
    // credentials) is excluded as a URL below, so this only fires on real secrets.
    /:\/\/[^/\s:@]+:[^/\s:@]+@/,
];

// Value charset that looks like an opaque token (base64 / hex / url-safe). URLs
// (which contain `:` and `?`) and human text (which contains spaces) are excluded.
const TOKEN_SHAPE_REGEX = /^[A-Za-z0-9+/_=\-.]+$/;
// A long pure-hex string is a hash/key/token (>=32 hex chars = >=128 bits). Hex's
// small alphabet keeps per-char entropy under the generic threshold, so match it
// by shape+length instead of relying on entropy.
const HEX_TOKEN_REGEX = /^[0-9a-f]{32,}$/i;
const ENTROPY_MIN_LENGTH = 20;
const ENTROPY_MIN_BITS_PER_CHAR = 3.5;

// A plain URL is not a secret (a credentialed connection string is caught earlier
// by the value patterns). Covers scheme URLs (https://host/path?query) and bare
// hosts/domains (google.com, www.x.example.com:8080/a/b). The bare form requires
// an alphabetic TLD so token-y values with dots (e.g. base64 chunks) aren't excluded.
const URL_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_URL_REGEX = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}(?::\d+)?(?:\/\S*)?$/i;

function looksLikeUrl(value: string): boolean {
    return URL_SCHEME_REGEX.test(value) || BARE_URL_REGEX.test(value);
}

// Values that are definitively not secrets, even under a sensitive-looking key:
// booleans, numbers, and very short strings. A real secret has length and shape.
const BOOLEAN_LITERALS = new Set(["true", "false", "yes", "no", "on", "off", "null", "none", "nil", "undefined"]);
const NUMERIC_REGEX = /^-?\d+(?:\.\d+)?$/;

function isObviouslyNotSecret(value: string): boolean {
    if (value.length <= 3) return true;
    if (NUMERIC_REGEX.test(value)) return true;
    return BOOLEAN_LITERALS.has(value.toLowerCase());
}

/** Shannon entropy in bits per character. O(n), cheap enough to run on input. */
function shannonEntropy(value: string): number {
    const counts = new Map<string, number>();
    for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
        const p = count / value.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

function matchesKnownPattern(value: string): boolean {
    return VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function looksHighEntropy(value: string): boolean {
    if (value.length < ENTROPY_MIN_LENGTH) return false;
    if (looksLikeUrl(value)) return false;
    if (!TOKEN_SHAPE_REGEX.test(value)) return false;
    if (HEX_TOKEN_REGEX.test(value)) return true;
    return shannonEntropy(value) >= ENTROPY_MIN_BITS_PER_CHAR;
}

/**
 * Classify whether `(key, value)` looks like a secret. Pure and synchronous -
 * safe to call on every keystroke (debounce for polish, not for cost).
 */
export function detectSensitive(key: string, value: string): SensitiveDetection {
    const trimmedValue = value.trim();
    if (trimmedValue === "") return NOT_SENSITIVE;

    // A template reference (`{{service.url}}`) is a pointer resolved at deploy
    // time, not a secret itself - regardless of how the key is named.
    if (trimmedValue.includes("{{")) return NOT_SENSITIVE;

    // Built-ins are injected, reserved, and plaintext.
    if (isReservedPreviewkitEnvKey(key)) return NOT_SENSITIVE;

    // Booleans / numbers / very short values are never secrets, even under a key
    // like FOO_SECRET (e.g. FEATURE_SECRET=true, RETRIES=3).
    if (isObviouslyNotSecret(trimmedValue)) return NOT_SENSITIVE;

    // Egregious values (a literal private key, a provider token) are flagged even
    // under a public-prefixed key, since that is almost certainly a mistake.
    if (matchesKnownPattern(trimmedValue)) {
        return { sensitive: true, reason: "value-pattern", confidence: "high" };
    }

    // Public-by-design keys: their values belong in the client bundle, so don't
    // flag them on name or entropy alone.
    const isPublicKey = PUBLIC_KEY_PREFIX_REGEX.test(key) || PUBLIC_KEY_TOKEN_REGEX.test(key);
    if (isPublicKey) return NOT_SENSITIVE;

    if (SENSITIVE_KEY_REGEX.test(key)) {
        return { sensitive: true, reason: "key-name", confidence: "high" };
    }

    if (looksHighEntropy(trimmedValue)) {
        return { sensitive: true, reason: "entropy", confidence: "medium" };
    }

    return NOT_SENSITIVE;
}
