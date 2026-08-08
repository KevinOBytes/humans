"use client";

import { useEffect, useState } from "react";

export function ParallaxNetwork() {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      setOffset(Math.max(-18, Math.min(18, window.scrollY * -0.035)));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -inset-x-10 -top-12 bottom-0 overflow-hidden opacity-75"
      style={{ transform: `translate3d(0, ${offset}px, 0)` }}
    >
      <svg viewBox="0 0 900 720" className="h-full w-full" fill="none">
        <defs>
          <linearGradient id="hero-line" x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#67e8f9" stopOpacity="0.06" />
            <stop offset="0.5" stopColor="#67e8f9" stopOpacity="0.65" />
            <stop offset="1" stopColor="#818cf8" stopOpacity="0.1" />
          </linearGradient>
          <filter id="hero-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="12" />
          </filter>
        </defs>
        <g stroke="url(#hero-line)" strokeWidth="1.2">
          <path d="M96 170 258 72l190 130 174-118 164 168-202 120-182-96-188 104Z" />
          <path d="m258 72 16 304m174-174-40 174m214-292-39 272M96 170l352 32m-316 78 356-190m-80 286 292-158" />
          <path
            d="M76 548 256 410l192 104 210-128 144 104"
            strokeDasharray="3 8"
          />
        </g>
        <g fill="#67e8f9" opacity="0.18" filter="url(#hero-glow)">
          <circle cx="448" cy="202" r="48" />
          <circle cx="630" cy="358" r="35" />
        </g>
        <g fill="#0b1012" stroke="#67e8f9" strokeWidth="2">
          <circle cx="96" cy="170" r="12" />
          <circle cx="258" cy="72" r="17" />
          <circle cx="448" cy="202" r="22" />
          <circle cx="622" cy="84" r="13" />
          <circle cx="786" cy="252" r="18" />
          <circle cx="630" cy="358" r="16" />
          <circle cx="448" cy="514" r="20" />
          <circle cx="260" cy="410" r="12" />
        </g>
        <g fill="#f5b94c" stroke="#f5b94c" strokeWidth="1.5">
          <circle cx="370" cy="330" r="6" />
          <circle cx="558" cy="294" r="6" />
          <circle cx="714" cy="450" r="6" />
        </g>
      </svg>
    </div>
  );
}
