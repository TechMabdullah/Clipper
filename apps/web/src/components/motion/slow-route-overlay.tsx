'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { MOTION_EASE } from '@/lib/motion';

export function SlowRouteOverlay() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, setNavigating] = React.useState(false);
  const [showOverlay, setShowOverlay] = React.useState(false);

  const routeKey = `${pathname}?${searchParams?.toString() ?? ''}`;
  const prevRouteRef = React.useRef(routeKey);

  // Clear immediately whenever route settles
  React.useEffect(() => {
    if (prevRouteRef.current !== routeKey) {
      prevRouteRef.current = routeKey;
      setNavigating(false);
      setShowOverlay(false);
    }
  }, [routeKey]);

  // Listen to internal link clicks so routes >350ms show a clean dimmed indicator
  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('http') || anchor.getAttribute('target') === '_blank') {
        return;
      }
      if (href !== pathname) {
        setNavigating(true);
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [pathname]);

  React.useEffect(() => {
    if (!navigating) {
      setShowOverlay(false);
      return;
    }
    const showTimer = window.setTimeout(() => setShowOverlay(true), 350);
    const safetyReset = window.setTimeout(() => {
      setNavigating(false);
      setShowOverlay(false);
    }, 8000);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(safetyReset);
    };
  }, [navigating]);

  return (
    <AnimatePresence>
      {showOverlay && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.15, ease: MOTION_EASE } }}
          className="pointer-events-none fixed inset-0 z-[95] flex items-end justify-end bg-background/40 backdrop-blur-[2px] p-6"
        >
          <div className="flex items-center gap-2.5 rounded-[16px] border border-border bg-card px-4 py-2.5 shadow-[var(--shadow-md)]">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-xs font-semibold text-foreground">Loading view…</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
