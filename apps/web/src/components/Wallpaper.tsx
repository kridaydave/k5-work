import { useEffect, useState } from "react";
import wallpaper from "@/assets/wallpaper.jpg";

/**
 * The painterly sunset artwork that sits behind the whole window, with a
 * gentle pointer parallax and the CRT-ish scanline / grain treatment.
 */
export function Wallpaper() {
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setOffset({
          x: event.clientX / window.innerWidth - 0.5,
          y: event.clientY / window.innerHeight - 0.5,
        });
      });
    };

    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden bg-ink-950" aria-hidden="true">
      {/* artwork */}
      <div
        className="absolute -inset-[6%] bg-cover bg-center transition-transform duration-[1200ms] ease-out"
        style={{
          backgroundImage: `url(${wallpaper})`,
          transform: `translate3d(${offset.x * -22}px, ${offset.y * -18}px, 0)`,
        }}
      />

      {/* warm bloom that slowly breathes */}
      <div className="animate-bloom absolute -inset-[10%] bg-[radial-gradient(60%_45%_at_42%_46%,rgba(255,138,74,0.30),rgba(221,92,58,0.10)_45%,transparent_72%)]" />

      {/* readability scrims */}
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(5,8,14,0.62)_0%,rgba(6,9,15,0.24)_16%,rgba(7,10,15,0.05)_30%,rgba(8,11,15,0.42)_46%,rgba(8,10,14,0.86)_62%,#080a0e_78%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_18%,transparent_38%,rgba(4,6,10,0.55)_100%)]" />

      {/* texture */}
      <div className="scanlines absolute inset-0" />
      <div className="scanlines-soft absolute inset-0" />
      <div className="grain absolute inset-0" />
    </div>
  );
}
