import { memo, useMemo, useState } from "react";
import { marked, type Token, type Tokens } from "marked";
import { CheckIcon, CopyIcon } from "@/components/icons";
import { cn } from "@/utils/cn";

type MarkdownProps = {
  content: string;
  variant?: "assistant" | "user";
  className?: string;
};

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const value = href.trim();
  if (value.startsWith("#") || value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return value;
  }
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

function CopyCodeButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard write failure
    }
  };

  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={handleCopy}
      className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-white/50 transition-colors hover:bg-white/10 hover:text-white"
    >
      {copied ? (
        <>
          <CheckIcon className="h-3 w-3 text-white/80" />
          <span className="text-white/80">Copied</span>
        </>
      ) : (
        <>
          <CopyIcon className="h-3 w-3" />
          <span>Copy</span>
        </>
      )}
    </button>
  );
}

function InlineToken({ token, keyIndex }: { token: Token; keyIndex: number }) {
  switch (token.type) {
    case "text":
      if ("tokens" in token && token.tokens && token.tokens.length > 0) {
        return (
          <span key={keyIndex}>
            {token.tokens.map((sub, i) => (
              <InlineToken key={i} token={sub} keyIndex={i} />
            ))}
          </span>
        );
      }
      return <span key={keyIndex}>{token.text}</span>;

    case "strong":
      return (
        <strong key={keyIndex} className="font-semibold text-white">
          {token.tokens?.map((sub, i) => (
            <InlineToken key={i} token={sub} keyIndex={i} />
          )) ?? token.text}
        </strong>
      );

    case "em":
      return (
        <em key={keyIndex} className="italic text-white/95">
          {token.tokens?.map((sub, i) => (
            <InlineToken key={i} token={sub} keyIndex={i} />
          )) ?? token.text}
        </em>
      );

    case "codespan":
      return (
        <code
          key={keyIndex}
          className="rounded border border-white/10 bg-white/[0.08] px-1.5 py-0.5 font-mono text-[0.88em] text-ember-200"
        >
          {token.text}
        </code>
      );

    case "del":
      return (
        <del key={keyIndex} className="text-white/50 line-through">
          {token.tokens?.map((sub, i) => (
            <InlineToken key={i} token={sub} keyIndex={i} />
          )) ?? token.text}
        </del>
      );

    case "link": {
      const href = safeHref(token.href);
      const content = token.tokens?.map((sub, i) => (
        <InlineToken key={i} token={sub} keyIndex={i} />
      )) ?? token.text;
      return href ? (
        <a
          key={keyIndex}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ember-300 underline underline-offset-2 transition-colors hover:text-ember-200"
        >
          {content}
        </a>
      ) : (
        <span key={keyIndex}>{content}</span>
      );
    }

    case "br":
      return <br key={keyIndex} />;

    default:
      return <span key={keyIndex}>{"text" in token ? token.text : ""}</span>;
  }
}

function InlineList({ tokens }: { tokens?: Token[] }) {
  if (!tokens || tokens.length === 0) return null;
  return (
    <>
      {tokens.map((token, i) => (
        <InlineToken key={i} token={token} keyIndex={i} />
      ))}
    </>
  );
}

function BlockToken({ token, keyIndex }: { token: Token; keyIndex: number }) {
  switch (token.type) {
    case "space":
      return null;

    case "heading": {
      const headingToken = token as Tokens.Heading;
      const content = <InlineList tokens={headingToken.tokens} />;
      switch (headingToken.depth) {
        case 1:
          return (
            <h1 key={keyIndex} className="mb-2 mt-4 text-[20px] font-semibold tracking-[-0.01em] text-white">
              {content}
            </h1>
          );
        case 2:
          return (
            <h2 key={keyIndex} className="mb-1.5 mt-3 text-[17px] font-semibold tracking-[-0.01em] text-white/95">
              {content}
            </h2>
          );
        case 3:
          return (
            <h3 key={keyIndex} className="mb-1 mt-2.5 text-[15px] font-semibold text-white/90">
              {content}
            </h3>
          );
        default:
          return (
            <h4 key={keyIndex} className="mb-1 mt-2 text-[14px] font-medium text-white/85">
              {content}
            </h4>
          );
      }
    }

    case "paragraph": {
      const pToken = token as Tokens.Paragraph;
      return (
        <p key={keyIndex} className="my-2 leading-[1.6]">
          <InlineList tokens={pToken.tokens} />
        </p>
      );
    }

    case "list": {
      const listToken = token as Tokens.List;
      const ListTag = listToken.ordered ? "ol" : "ul";
      return (
        <ListTag
          key={keyIndex}
          start={listToken.ordered ? listToken.start || 1 : undefined}
          className={cn(
            "my-2.5 space-y-1.5 pl-6 marker:text-white/40",
            listToken.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {listToken.items.map((item, itemIdx) => (
            <li key={itemIdx} className="pl-0.5 leading-[1.6]">
              {item.task && (
                <input
                  type="checkbox"
                  checked={item.checked}
                  readOnly
                  className="mr-2 inline-block h-3.5 w-3.5 rounded border-white/20 bg-white/10 accent-white align-middle"
                />
              )}
              {item.tokens && item.tokens.length > 0 ? (
                <>
                  {item.tokens.map((subToken, subIdx) => {
                    if (subToken.type === "text") {
                      const textToken = subToken as Tokens.Text;
                      return <InlineList key={subIdx} tokens={textToken.tokens} />;
                    }
                    if (subToken.type === "list") {
                      return <BlockToken key={subIdx} token={subToken} keyIndex={subIdx} />;
                    }
                    return <BlockToken key={subIdx} token={subToken} keyIndex={subIdx} />;
                  })}
                </>
              ) : (
                item.text
              )}
            </li>
          ))}
        </ListTag>
      );
    }

    case "code": {
      const codeToken = token as Tokens.Code;
      return (
        <div
          key={keyIndex}
          className="group relative my-3 overflow-hidden rounded-xl border border-white/10 bg-black/60 shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 font-mono text-[11.5px] text-white/40">
            <span>{codeToken.lang || "text"}</span>
            <CopyCodeButton text={codeToken.text} />
          </div>
          <pre className="thin-scroll overflow-x-auto p-3.5 font-mono text-[13px] leading-relaxed text-white/90">
            <code>{codeToken.text}</code>
          </pre>
        </div>
      );
    }

    case "blockquote": {
      const bqToken = token as Tokens.Blockquote;
      return (
        <blockquote
          key={keyIndex}
          className="my-2.5 border-l-2 border-white/20 pl-3.5 italic text-white/70"
        >
          {bqToken.tokens.map((subToken, i) => (
            <BlockToken key={i} token={subToken} keyIndex={i} />
          ))}
        </blockquote>
      );
    }

    case "hr":
      return <hr key={keyIndex} className="my-4 border-white/10" />;

    case "table": {
      const tableToken = token as Tokens.Table;
      return (
        <div key={keyIndex} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse border border-white/10 text-left text-[13.5px]">
            <thead className="bg-white/[0.04]">
              <tr>
                {tableToken.header.map((cell, cellIdx) => (
                  <th
                    key={cellIdx}
                    className="border border-white/10 px-3 py-2 font-semibold text-white/90"
                    style={{ textAlign: tableToken.align[cellIdx] ?? "left" }}
                  >
                    <InlineList tokens={cell.tokens} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableToken.rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="hover:bg-white/[0.02]">
                  {row.map((cell, cellIdx) => (
                    <td
                      key={cellIdx}
                      className="border border-white/10 px-3 py-1.5 text-white/80"
                      style={{ textAlign: tableToken.align[cellIdx] ?? "left" }}
                    >
                      <InlineList tokens={cell.tokens} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    default:
      if ("tokens" in token && token.tokens && Array.isArray(token.tokens)) {
        return (
          <div key={keyIndex} className="my-1">
            <InlineList tokens={token.tokens} />
          </div>
        );
      }
      return <div key={keyIndex}>{"text" in token ? token.text : ""}</div>;
  }
}

export const Markdown = memo(function Markdown({
  content,
  variant = "assistant",
  className,
}: MarkdownProps) {
  const tokens = useMemo(() => {
    // normalize bullet marks like "•" or "●" into markdown "- "
    const normalized = content.replace(/^[ \t]*[•●]\s+/gm, "- ");
    return marked.lexer(normalized);
  }, [content]);

  return (
    <div
      className={cn(
        "markdown-body text-white/90",
        variant === "assistant" ? "font-serif text-[16px]" : "font-sans text-[14px]",
        className,
      )}
    >
      {tokens.map((token, i) => (
        <BlockToken key={i} token={token} keyIndex={i} />
      ))}
    </div>
  );
});
