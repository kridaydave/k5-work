import { useCallback, useEffect, useState } from "react";
import { BottomDock } from "@/components/BottomDock";
import { Composer } from "@/components/Composer";
import { Sidebar } from "@/components/Sidebar";
import { Wallpaper } from "@/components/Wallpaper";
import { WindowChrome } from "@/components/WindowChrome";

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(id);
  }, [toast]);

  const handleSend = useCallback((text: string) => {
    const head = text.length > 42 ? `${text.slice(0, 42).trimEnd()}…` : text;
    setToast(`Sent to Fable 5.1 · “${head}”`);
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
        <Wallpaper />

        <WindowChrome sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />

        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        <main className="thin-scroll relative z-10 flex flex-1 flex-col overflow-y-auto px-4 sm:px-8">
          {/* breathing room above the composer so the artwork can breathe */}
          <div className="min-h-[12vh] flex-1" aria-hidden="true" />

          <div className="mx-auto w-full max-w-[900px] pb-[clamp(1.75rem,7vh,4.5rem)]">
            <Composer onSend={handleSend} />
          </div>
        </main>

        <BottomDock />

        {toast && (
          <div
            role="status"
            className="animate-toast-in pointer-events-none fixed bottom-28 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 truncate rounded-full border border-white/10 bg-black/70 px-4 py-2 text-[13px] font-medium text-white/85 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl"
          >
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
