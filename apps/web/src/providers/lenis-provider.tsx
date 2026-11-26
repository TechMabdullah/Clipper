'use client';

import * as React from 'react';
import Lenis from 'lenis';

interface LenisContextValue {
  lenis: Lenis | null;
  scrollTo: (target: string | number | HTMLElement, options?: { offset?: number }) => void;
}

const LenisContext = React.createContext<LenisContextValue>({
  lenis: null,
  scrollTo: () => {},
});

export function useLenis() {
  return React.useContext(LenisContext);
}

export function LenisProvider({ children }: { children: React.ReactNode }) {
  const [lenisInstance, setLenisInstance] = React.useState<Lenis | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    const lenis = new Lenis({
      duration: 1.05,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      touchMultiplier: 1.5,
      prevent: (node) =>
        Boolean(node.closest('[data-lenis-prevent], [role="dialog"], [vaul-drawer]')),
    });
    setLenisInstance(lenis);

    let rafId = 0;
    const raf = (time: number) => {
      lenis.raf(time);
      rafId = window.requestAnimationFrame(raf);
    };
    rafId = window.requestAnimationFrame(raf);

    return () => {
      window.cancelAnimationFrame(rafId);
      lenis.destroy();
      setLenisInstance(null);
    };
  }, []);

  const scrollTo = React.useCallback(
    (target: string | number | HTMLElement, options?: { offset?: number }) => {
      if (lenisInstance) {
        lenisInstance.scrollTo(target, { offset: options?.offset ?? -72 });
      } else if (typeof target === 'number') {
        window.scrollTo({ top: target, behavior: 'smooth' });
      } else if (typeof target === 'string') {
        const el = document.querySelector(target);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (target instanceof HTMLElement) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    [lenisInstance],
  );

  return (
    <LenisContext.Provider value={{ lenis: lenisInstance, scrollTo }}>
      {children}
    </LenisContext.Provider>
  );
}
