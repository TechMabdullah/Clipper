'use client';

import * as React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Loader2, Sparkles } from 'lucide-react';
import { useLoader } from '@/stores/loader-store';
import { MOTION_EASE, MOTION_SPRING } from '@/lib/motion';

export function GlobalLoaderOverlay() {
  const { visible, message } = useLoader();
  const reduced = useReducedMotion();

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="global-action-loader"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.18, ease: MOTION_EASE } }}
          role="status"
          aria-live="assertive"
          aria-busy="true"
          className="fixed inset-0 z-[110] flex items-center justify-center bg-[#1A1A2E]/45 backdrop-blur-md p-4"
        >
          <motion.div
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 12 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 8 }}
            transition={MOTION_SPRING}
            className="flex min-w-[260px] max-w-sm items-center gap-4 rounded-[24px] border border-border/70 bg-card/95 px-6 py-5 shadow-[var(--shadow-lg)]"
          >
            <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] bg-primary/12 text-primary">
              <Loader2 className="h-6 w-6 animate-spin" />
              <Sparkles className="absolute -right-1 -top-1 h-4 w-4 text-[#FF8A30]" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-foreground">Just a moment</p>
              <p className="truncate text-xs text-muted-foreground">{message || 'Working on it…'}</p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
