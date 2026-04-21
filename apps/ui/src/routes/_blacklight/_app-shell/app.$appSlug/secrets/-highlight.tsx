import { Fragment, type ReactNode } from "react";

type Lang = "bash" | "javascript";

interface Token {
  className: string;
  match: RegExp;
}

const BASH_TOKENS: Token[] = [
  { className: "text-text-tertiary italic", match: /#[^\n]*/y },
  { className: "text-[#a5e075]", match: /"(?:\\.|[^"\\])*"/y },
  { className: "text-[#a5e075]", match: /'(?:\\.|[^'\\])*'/y },
  { className: "text-[#ffb86c]", match: /\$[A-Za-z_][A-Za-z0-9_]*/y },
  { className: "text-[#ff79c6]", match: /(?:^|\s)(?:curl|echo|export|cd|cat|ls|grep|sed|awk)(?=\s|$)/y },
  { className: "text-[#bd93f9]", match: /(?:^|\s)-{1,2}[A-Za-z][\w-]*/y },
];

const JS_TOKENS: Token[] = [
  { className: "text-text-tertiary italic", match: /\/\/[^\n]*/y },
  { className: "text-text-tertiary italic", match: /\/\*[\s\S]*?\*\//y },
  { className: "text-[#a5e075]", match: /`(?:\\.|\$\{[^}]*\}|[^`\\])*`/y },
  { className: "text-[#a5e075]", match: /"(?:\\.|[^"\\])*"/y },
  { className: "text-[#a5e075]", match: /'(?:\\.|[^'\\])*'/y },
  { className: "text-[#ff79c6]", match: /\b(?:import|from|export|default|as)\b/y },
  {
    className: "text-[#bd93f9]",
    match: /\b(?:const|let|var|function|return|if|else|for|while|new|await|async|of|in|typeof)\b/y,
  },
  { className: "text-[#8be9fd]", match: /\b(?:true|false|null|undefined)\b/y },
  { className: "text-[#ffb86c]", match: /\b\d+(?:\.\d+)?\b/y },
];

function tokenize(code: string, tokens: Token[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let buffer = "";
  let key = 0;

  function flushBuffer() {
    if (buffer.length === 0) return;
    out.push(<Fragment key={key++}>{buffer}</Fragment>);
    buffer = "";
  }

  while (i < code.length) {
    let matched = false;
    for (const token of tokens) {
      token.match.lastIndex = i;
      const match = token.match.exec(code);
      if (match != null && match.index === i && match[0].length > 0) {
        flushBuffer();
        out.push(
          <span key={key++} className={token.className}>
            {match[0]}
          </span>,
        );
        i += match[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      buffer += code[i];
      i += 1;
    }
  }
  flushBuffer();
  return out;
}

export function Highlight({ code, language }: { code: string; language: Lang }) {
  const tokens = language === "bash" ? BASH_TOKENS : JS_TOKENS;
  return <>{tokenize(code, tokens)}</>;
}
