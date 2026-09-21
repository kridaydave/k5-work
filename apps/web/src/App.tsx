import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "@/components/Composer";
import { Sidebar } from "@/components/Sidebar";
import { Wallpaper } from "@/components/Wallpaper";
import { WindowChrome } from "@/components/WindowChrome";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

const REPLY_DELAY_MS = 1400;

function simulatedReply(prompt: string, followUp: boolean): string {
  const head = prompt.length > 64 ? `${prompt.slice(0, 64).trimEnd()}…` : prompt;
  if (!followUp) {
    return `Here's a first pass at “${head}”:\n\n• Mapped the relevant files in this workspace\n• Drafted the smallest change that fits the existing patterns\n\nSay the word and I'll refine it — or tell me what to adjust.`;
  }
  return `On it — folding that in:\n\n• Updated the draft for “${head}”\n• Re-ran the targeted checks\n\nAnything else to tweak?`;
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  /** composer rect captured just before the first send, for the morph animation */
  const firstRect = useRef<DOMRect | null>(null);
  const timers = useRef<number[]>([]);
  const outstanding = useRef(0);
  const exchangeCount = useRef(0);

  const active = messages.length > 0;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const pendingTimers = timers.current;
    return () => {
      pendingTimers.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  // morph the composer from centered to bottom-docked on the first send (FLIP)
  useEffect(() => {
    const first = firstRect.current;
    firstRect.current = null;
    const el = composerWrapRef.current;
    if (!first || !el || messages.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const last = el.getBoundingClientRect();
    const dy = first.top - last.top;
    if (Math.abs(dy) < 4) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
      duration: 450,
      easing: "cubic-bezier(0.16,0.84,0.28,1)",
    });
  }, [messages.length]);

  // keep the latest message in view as the thread grows
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, [messages.length, pending]);

  const handleSend = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // capture where the composer sits now so it can morph to the bottom
    firstRect.current = composerWrapRef.current?.getBoundingClientRect() ?? null;
    const followUp = exchangeCount.current > 0;
    exchangeCount.current += 1;
    setMessages((prev) => [...prev, { id: `${Date.now()}-user`, role: "user", text: trimmed }]);
    outstanding.current += 1;
    setPending(true);
    const id = window.setTimeout(() => {
      outstanding.current -= 1;
      setMessages((prev) => [
        ...prev,
        { id: `${Date.now()}-assistant`, role: "assistant", text: simulatedReply(trimmed, followUp) },
      ]);
      if (outstanding.current <= 0) setPending(false);
    }, REPLY_DELAY_MS);
    timers.current.push(id);
  }, []);

  return (
    <div className="relative min-h-[100dvh] w-full bg-ink-1000 p-0 font-sans antialiased lg:p-3">
      <h1 className="sr-only">Cowork — do anything with Claude</h1>

      <div
        className={[
          "relative isolate flex h-[100dvh] w-full flex-col overflow-hidden bg-ink-950",
          "lg:h-[calc(100dvh-1.5rem)] lg:rounded-[26px] lg:ring-1 lg:ring-white/[0.08]",
          "lg:shadow-[0_50px_150px_-40px_rgba(0,0,0,0.95)]",
        ].join(" ")}
      >
        <Wallpaper active={active} />

        <WindowChrome sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />

        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        <main ref={mainRef} className="thin-scroll relative z-10 flex flex-1 flex-col overflow-y-auto px-4 sm:px-8">
          {active ? (
            <div
              aria-live="polite"
              className="mx-auto flex w-full max-w-[800px] flex-1 flex-col justify-end gap-4 py-6"
            >
              {messages.map((message) =>
                message.role === "user" ? (
                  <div key={message.id} className="animate-fade-up flex justify-end">
                    <p className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-white/10 bg-white/[0.07] px-4 py-2.5 text-[14px] leading-relaxed text-white/90">
                      {message.text}
                    </p>
                  </div>
                ) : (
                  <div key={message.id} className="animate-fade-up max-w-[90%]">
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/30">
                      Fable 5.1
                    </p>
                    <p className="whitespace-pre-wrap font-serif text-[16.5px] leading-[1.55] text-white/90">
                      {message.text}
                    </p>
                  </div>
                ),
              )}
              {pending && (
                <div className="flex items-center gap-1.5 py-1" aria-label="Fable is typing">
                  {[0, 1, 2].map((dot) => (
                    <span
                      key={dot}
                      className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/40"
                      style={{ animationDelay: `${dot * 180}ms` }}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* empty state — composer rests in the middle of the artwork */
            <div className="flex flex-1 flex-col justify-center">
              <div ref={composerWrapRef} className="mx-auto w-full max-w-[800px]">
                <Composer onSend={handleSend} />
              </div>
            </div>
          )}

          {active && (
            <div className="sticky bottom-0 z-10 bg-[linear-gradient(to_top,rgba(8,10,14,0.96)_55%,rgba(8,10,14,0))]">
              <div ref={composerWrapRef} className="mx-auto w-full max-w-[800px] pb-[clamp(1rem,4vh,2.5rem)] pt-3">
                <Composer onSend={handleSend} compact />
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
