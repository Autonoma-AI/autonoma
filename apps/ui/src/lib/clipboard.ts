/**
 * Copy text to the clipboard, reporting whether it actually landed.
 *
 * `navigator.clipboard` is undefined outside a secure context and its write can
 * reject (permissions, an unfocused document), so a call site that only uses it
 * has a path where the button does nothing at all - no copy, no error, and no
 * state change in whatever UI was waiting on the result. The `execCommand`
 * fallback is deprecated but is the only thing that works there, so it is what
 * stands between those users and a dead button.
 *
 * Returns a boolean rather than throwing because every caller wants the same
 * thing: flip to "copied" on success, say something useful on failure.
 */
export async function copyText(text: string): Promise<boolean> {
    if (navigator.clipboard != null) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.warn("Clipboard write rejected, falling back to execCommand", err);
        }
    }

    return copyWithExecCommand(text);
}

/**
 * The pre-async-clipboard path: put the text in an offscreen textarea, select it,
 * and let the document copy the selection. Requires a real element in the
 * document, so it cannot run server-side or before mount.
 */
function copyWithExecCommand(text: string): boolean {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Offscreen rather than hidden: `display:none` and `visibility:hidden` are not
    // selectable, and the selection is what gets copied.
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.setAttribute("readonly", "");
    document.body.appendChild(textarea);

    try {
        textarea.select();
        return document.execCommand("copy");
    } catch (err) {
        console.warn("Failed to copy text to the clipboard", err);
        return false;
    } finally {
        document.body.removeChild(textarea);
    }
}
