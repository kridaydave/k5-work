import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom ships neither of these, and the components use both for real: the
// sidebar collapses below 1024px, and the composer animates only when motion is
// allowed. Stubbed to the permissive default so a test exercises the desktop
// path unless it says otherwise.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (typeof window !== "undefined" && typeof window.scrollTo !== "function") {
  Object.defineProperty(window, "scrollTo", { writable: true, value: () => {} });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
