/** Two-note chime, synthesized so no audio asset is needed. */
const NOTES_HZ = [880, 1174.66];
const NOTE_DURATION_S = 0.18;
const NOTE_GAP_S = 0.12;
const PEAK_GAIN = 0.08;

/**
 * Play a short attention chime via WebAudio. Best-effort: browsers block audio
 * until the user has interacted with the page, so this can silently no-op on a
 * fresh load - fine for a nicety layered on top of the visual attention cues.
 */
export function playChime(): void {
    try {
        const context = new AudioContext();
        NOTES_HZ.forEach((frequency, index) => {
            const start = context.currentTime + index * NOTE_GAP_S;
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = "sine";
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + NOTE_DURATION_S);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start(start);
            oscillator.stop(start + NOTE_DURATION_S);
        });
        // Free the context once the notes have played out.
        const totalMs = (NOTES_HZ.length * NOTE_GAP_S + NOTE_DURATION_S) * 1000;
        setTimeout(() => {
            void context.close().catch(() => undefined);
        }, totalMs + 100);
    } catch (err) {
        // Autoplay policy or missing WebAudio - visual cues still cover the alert.
        console.debug("Attention chime unavailable", err);
    }
}
