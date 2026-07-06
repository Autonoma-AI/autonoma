// CodeReveal.jsx - Autonoma SDK stepped code walkthrough.
// Self-contained click-through ("slides") version with Next/Back controls.
// Each step reveals more of the config and pins an annotation to the active line.
import React from "react";

function hexA(hex, a) {
  const h = String(hex || "#C2E812").replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

const MONO = "'Geist Mono Variable', ui-monospace, monospace";
const SANS = "'DM Sans Variable', system-ui, sans-serif";

// Code model - each line is [text, type] segments + the step at which it appears.
// A 3rd value on a segment is its own appear-step (overrides the line's).
const CODE = [
  {
    indent: 0,
    appear: 1,
    segs: [
      ["createExpressHandler", "fn"],
      ["({", "punct"],
    ],
  },
  {
    indent: 2,
    appear: 1,
    segs: [
      ["factories", "key"],
      [": {", "punct"],
    ],
  },
  {
    indent: 4,
    appear: 0,
    segs: [
      ["User", "key", 1],
      [": ", "punct", 1],
      ["defineFactory", "fn"],
      ["({", "punct"],
    ],
  },
  {
    indent: 6,
    appear: 2,
    segs: [
      ["inputSchema", "beatkey"],
      [": ", "punct"],
      ["UserInput", "ident"],
      [",", "punct"],
    ],
  },
  {
    indent: 6,
    appear: 3,
    segs: [
      ["create", "beatkey"],
      [":   ", "punct"],
      ["(data)", "param"],
      [" => ", "punct"],
      ["userService.create(data)", "ident"],
      [",", "punct"],
    ],
  },
  {
    indent: 6,
    appear: 4,
    segs: [
      ["teardown", "beatkey"],
      [": ", "punct"],
      ["(record)", "param"],
      [" => ", "punct"],
      ["userService.delete(record.id)", "ident"],
      [",", "punct"],
    ],
  },
  { indent: 4, appear: 0, segs: [["}),", "punct"]] },
  { indent: 2, appear: 1, segs: [["},", "punct"]] },
  {
    indent: 2,
    appear: 5,
    segs: [
      ["auth", "beatkey"],
      [": ", "punct"],
      ["(user)", "param"],
      [" => ({ ", "punct"],
      ["headers", "key"],
      [": ", "punct"],
      ["signIn(user)", "ident"],
      [" })", "punct"],
    ],
  },
  { indent: 0, appear: 1, segs: [["})", "punct"]] },
];

// Annotation pinned to each step (null = recap step, which shows a centered caption).
const NOTES = {
  0: {
    line: 2,
    label: "FACTORY",
    comment: "one factory per model",
    body: "Each model the agent can create gets a factory - start with one.",
  },
  1: {
    line: 0,
    label: "HANDLER",
    comment: "your single Autonoma endpoint",
    body: "Wrap the factory in the request handler, mounted at one route.",
  },
  2: {
    line: 3,
    label: "INPUT SCHEMA",
    comment: "the shape of the test data",
    body: "Defines and validates the data each test sends in - typed, no guessing.",
  },
  3: {
    line: 4,
    label: "CREATE",
    comment: "calls your real service",
    body: "Reuses your own create function, so test data runs the same business logic as production.",
  },
  4: {
    line: 5,
    label: "TEARDOWN",
    comment: "deletes exactly what it made",
    body: "Cleans up after every test. Nothing is left behind in your database.",
  },
  5: {
    line: 8,
    label: "AUTH",
    comment: "signs the agent into your app",
    body: "Returns credentials so the agent can reach your authenticated app.",
  },
};
const TOTAL = 7; // steps 0..6 (6 = recap)

// Layout geometry (1280x720 canvas)
const WIN = { x: 96, y: 150, w: 728, titlebar: 42, padX: 30, padY: 24 };
const LINE_H = 33,
  FONT = 18;
const lineTop = (i) => WIN.y + WIN.titlebar + WIN.padY + i * LINE_H;
const lineCenter = (i) => lineTop(i) + LINE_H / 2;
const WIN_RIGHT = WIN.x + WIN.w;
const WIN_BOTTOM = lineTop(CODE.length - 1) + LINE_H + WIN.padY;
const ANNO_X = 838,
  ANNO_W = 400;

function CornerTicks({ color, size = 9 }) {
  const base = { position: "absolute", width: size, height: size, pointerEvents: "none" };
  return (
    <>
      <div
        style={{ ...base, left: -1, top: -1, borderLeft: `1.5px solid ${color}`, borderTop: `1.5px solid ${color}` }}
      />
      <div
        style={{ ...base, right: -1, top: -1, borderRight: `1.5px solid ${color}`, borderTop: `1.5px solid ${color}` }}
      />
      <div
        style={{
          ...base,
          left: -1,
          bottom: -1,
          borderLeft: `1.5px solid ${color}`,
          borderBottom: `1.5px solid ${color}`,
        }}
      />
      <div
        style={{
          ...base,
          right: -1,
          bottom: -1,
          borderRight: `1.5px solid ${color}`,
          borderBottom: `1.5px solid ${color}`,
        }}
      />
    </>
  );
}

function NavButton({ label, primary, disabled, onClick, accent }) {
  const [h, setH] = React.useState(false);
  const base = {
    fontFamily: MONO,
    fontSize: 12.5,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    padding: "11px 22px",
    border: "1px solid",
    cursor: disabled ? "default" : "pointer",
    userSelect: "none",
    transition: "all .15s ease",
    fontWeight: primary ? 600 : 500,
  };
  let style;
  if (primary) {
    style = {
      ...base,
      background: accent,
      borderColor: accent,
      color: "#050505",
      boxShadow: `0 0 ${h ? 26 : 14}px ${hexA(accent, 0.4)}`,
      transform: h ? "translateY(-1px)" : "none",
    };
  } else {
    style = {
      ...base,
      background: h && !disabled ? "#191919" : "transparent",
      borderColor: h && !disabled ? "#444" : "#2A2A2A",
      color: disabled ? "#3A3A3A" : h ? "#EDEDED" : "#9A9A9A",
      opacity: disabled ? 0.5 : 1,
    };
  }
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={style}
    >
      {label}
    </button>
  );
}

function Controls({ step, accent, onNext, onPrev }) {
  const last = step === TOTAL - 1;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 662,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
      }}
    >
      <NavButton label="Back" disabled={step === 0} onClick={onPrev} accent={accent} />
      <div style={{ display: "flex", gap: 7, margin: "0 4px" }}>
        {Array.from({ length: TOTAL }).map((_, k) => (
          <div
            key={k}
            style={{
              width: 9,
              height: 9,
              background: k === step ? accent : k < step ? hexA(accent, 0.35) : "#2A2A2A",
              boxShadow: k === step ? `0 0 8px ${hexA(accent, 0.6)}` : "none",
              transition: "background .3s ease, box-shadow .3s ease",
            }}
          />
        ))}
      </div>
      <NavButton label={last ? "Restart" : "Next"} primary onClick={onNext} accent={accent} />
    </div>
  );
}

function CodeRevealScene({ framing, annotation, accent, step, onNext, onPrev }) {
  const COLORS = { fn: accent, key: "#C7CFD6", ident: "#7E8B97", param: "#8B8B8B", punct: "#585B5F" };
  const noted = NOTES[step] || null;
  const lastNoteRef = React.useRef(NOTES[0]);
  if (noted) lastNoteRef.current = noted;
  const shown = noted || lastNoteRef.current;
  const activeLine = noted ? noted.line : null;
  const doSpotlight = step >= 2 && step <= 5;
  const isRecap = step === TOTAL - 1;
  const ease = "opacity .45s ease, transform .45s ease";
  const vis = noted ? 1 : 0;
  const cy = lineCenter(shown.line);

  return (
    <div style={{ position: "absolute", inset: 0, background: "#050505", overflow: "hidden" }}>
      {/* Dotted-grid void */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `radial-gradient(circle at center, rgba(255,255,255,${framing === "bare" ? 0.07 : 0.045}) 1px, transparent 1px)`,
          backgroundSize: "24px 24px",
        }}
      />

      {/* Brand mark */}
      <div style={{ position: "absolute", left: 60, top: 56, display: "flex", alignItems: "center", gap: 11 }}>
        <div style={{ width: 13, height: 13, background: accent, boxShadow: `0 0 12px ${hexA(accent, 0.6)}` }} />
        <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 15, color: "#EDEDED", letterSpacing: "0.01em" }}>
          Autonoma
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.16em", color: "#5A5A5A", marginLeft: 4 }}>
          SDK SETUP
        </span>
      </div>

      {/* Editor window chrome */}
      {framing === "editor" && (
        <div
          style={{
            position: "absolute",
            left: WIN.x,
            top: WIN.y,
            width: WIN.w,
            height: WIN_BOTTOM - WIN.y,
            background: "#0B0B0B",
            border: "1px solid #242424",
          }}
        >
          <div
            style={{
              height: WIN.titlebar,
              borderBottom: "1px solid #1E1E1E",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 16px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 7, height: 7, background: accent, boxShadow: `0 0 8px ${accent}` }} />
              <span style={{ fontFamily: MONO, fontSize: 12, color: "#8A8A8A" }}>autonoma.config.ts</span>
            </div>
            <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.16em", color: "#5A5A5A" }}>TS</span>
          </div>
          <CornerTicks color={hexA(accent, 0.45)} />
        </div>
      )}

      {/* Bare filename eyebrow */}
      {framing === "bare" && (
        <div
          style={{
            position: "absolute",
            left: WIN.x + WIN.padX,
            top: WIN.y - 26,
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: "0.16em",
            color: "#5A5A5A",
          }}
        >
          AUTONOMA.CONFIG.TS
        </div>
      )}

      {/* Active-line highlight band */}
      <div
        style={{
          position: "absolute",
          left: WIN.x + 1,
          top: lineTop(shown.line) - 4,
          width: WIN.w - 2,
          height: LINE_H + 8,
          background: hexA(accent, 0.06),
          borderLeft: `2px solid ${hexA(accent, 0.85)}`,
          opacity: vis,
          transition: "top .45s ease, opacity .4s ease",
          pointerEvents: "none",
        }}
      />

      {/* Code lines */}
      {CODE.map((ln, i) => {
        const visible = step >= ln.appear;
        const spot = doSpotlight ? (i === activeLine ? 1 : 0.3) : 1;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: WIN.x + WIN.padX + ln.indent * 10,
              top: lineTop(i),
              height: LINE_H,
              display: "flex",
              alignItems: "center",
              fontFamily: MONO,
              fontSize: FONT,
              lineHeight: 1,
              whiteSpace: "pre",
              opacity: visible ? spot : 0,
              transform: `translateY(${visible ? 0 : 8}px)`,
              transition: ease,
              pointerEvents: "none",
            }}
          >
            {ln.segs.map((s, j) => {
              const [txt, type, segAppear] = s;
              let color = COLORS[type] || "#ccc";
              let textShadow = "none";
              if (type === "beatkey") {
                const lit = step >= ln.appear;
                color = lit ? accent : COLORS.key;
                if (lit) textShadow = `0 0 10px ${hexA(accent, 0.5)}`;
              }
              const segOp = segAppear != null ? (step >= segAppear ? 1 : 0) : 1;
              return (
                <span key={j} style={{ color, textShadow, opacity: segOp, transition: "opacity .4s ease" }}>
                  {txt}
                </span>
              );
            })}
          </div>
        );
      })}

      {/* Connector + annotation (slides between lines as the step changes) */}
      <div
        style={{
          position: "absolute",
          left: WIN_RIGHT,
          top: cy - 0.5,
          width: ANNO_X - WIN_RIGHT,
          height: 1,
          background: hexA(accent, 0.6),
          opacity: vis,
          transition: "top .45s ease, opacity .4s ease",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: WIN_RIGHT - 3,
          top: cy - 3,
          width: 6,
          height: 6,
          background: accent,
          boxShadow: `0 0 8px ${hexA(accent, 0.8)}`,
          opacity: vis,
          transition: "top .45s ease, opacity .4s ease",
          pointerEvents: "none",
        }}
      />
      {annotation === "comment" ? (
        <div
          style={{
            position: "absolute",
            left: ANNO_X,
            top: cy - 20,
            width: ANNO_W,
            opacity: vis,
            transition: "top .45s ease, opacity .4s ease",
            fontFamily: MONO,
            fontSize: 18,
            lineHeight: 1.45,
            pointerEvents: "none",
          }}
        >
          <span style={{ color: accent }}>// </span>
          <span style={{ color: "#AEB8A0" }}>{shown.comment}</span>
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            left: ANNO_X,
            top: cy - 47,
            width: ANNO_W,
            opacity: vis,
            transition: "top .45s ease, opacity .4s ease",
            background: "#0C0C0C",
            border: "1px solid #2A2A2A",
            padding: "14px 16px",
            pointerEvents: "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
            <div style={{ width: 6, height: 6, background: accent, boxShadow: `0 0 8px ${accent}` }} />
            <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.13em", color: accent }}>
              {shown.label}
            </span>
          </div>
          <div style={{ fontFamily: SANS, fontSize: 15, lineHeight: 1.5, color: "#D6D6D6" }}>{shown.body}</div>
          <CornerTicks color={hexA(accent, 0.5)} size={7} />
        </div>
      )}

      {/* Recap caption */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 590,
          textAlign: "center",
          opacity: isRecap ? 1 : 0,
          transform: `translateY(${isRecap ? 0 : 8}px)`,
          transition: ease,
          pointerEvents: "none",
        }}
      >
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.18em", color: accent, marginBottom: 8 }}>
          THE WHOLE LOOP
        </div>
        <div style={{ fontFamily: SANS, fontSize: 19, fontWeight: 500, color: "#E4E4E4" }}>
          Create real data &nbsp;&rarr;&nbsp; test it &nbsp;&rarr;&nbsp; tear it down. Automatically.
        </div>
      </div>

      <Controls step={step} accent={accent} onNext={onNext} onPrev={onPrev} />
    </div>
  );
}

export default function CodeReveal(props) {
  const framing = props.framing || "editor";
  const annotation = props.annotation || "card";
  const accent = props.accent || "#C2E812";

  const [step, setStep] = React.useState(0);

  // Auto-play once the widget scrolls into view; stop as soon as the user takes over.
  const AUTOPLAY_START_MS = 1200; // let the viewer register step 0 before advancing
  const AUTOPLAY_STEP_MS = 2800; // dwell per step (loops back to 0 at the end)
  const userTookOverRef = React.useRef(false);
  const [playing, setPlaying] = React.useState(false);

  const takeOver = React.useCallback(() => {
    userTookOverRef.current = true;
    setPlaying(false);
  }, []);
  const next = React.useCallback(() => {
    takeOver();
    setStep((s) => (s >= TOTAL - 1 ? 0 : s + 1));
  }, [takeOver]);
  const prev = React.useCallback(() => {
    takeOver();
    setStep((s) => Math.max(0, s - 1));
  }, [takeOver]);

  // Auto-scale the 1280x720 canvas to the host container width.
  const wrapRef = React.useRef(null);

  // Start playing when in view; pause when scrolled away (unless the user took over).
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !userTookOverRef.current) setPlaying(true);
          else if (!e.isIntersecting) setPlaying(false);
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The auto-advance ticker: loops back to the start and keeps going.
  React.useEffect(() => {
    if (!playing) return;
    let interval;
    const startTimeout = setTimeout(() => {
      interval = setInterval(() => {
        setStep((s) => (s >= TOTAL - 1 ? 0 : s + 1));
      }, AUTOPLAY_STEP_MS);
    }, AUTOPLAY_START_MS);
    return () => {
      clearTimeout(startTimeout);
      if (interval) clearInterval(interval);
    };
  }, [playing]);
  const [scale, setScale] = React.useState(1);
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth || 1280;
      setScale(Math.max(0.1, w / 1280));
    };
    measure();
    let frames = 0,
      rafId;
    const loop = () => {
      measure();
      if (frames++ < 24) rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        width: "100%",
        height: 720 * scale,
        background: "#050505",
        border: "1px solid #1A1A1A",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: 1280,
          height: 720,
          position: "absolute",
          top: 0,
          left: 0,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        <CodeRevealScene
          framing={framing}
          annotation={annotation}
          accent={accent}
          step={step}
          onNext={next}
          onPrev={prev}
        />
      </div>
    </div>
  );
}
