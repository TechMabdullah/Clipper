'use client';

import * as React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { MOTION_EASE, MOTION_SPRING } from '@/lib/motion';

const PRELOADER_SESSION_KEY = 'clipper_preloader_seen_v1';

export function GlobalPreloader() {
  const reduced = useReducedMotion();
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (reduced) return;

    let alreadySeen = false;
    try {
      alreadySeen = window.sessionStorage.getItem(PRELOADER_SESSION_KEY) === '1';
      if (!alreadySeen) {
        window.sessionStorage.setItem(PRELOADER_SESSION_KEY, '1');
      }
    } catch {
      alreadySeen = false;
    }

    if (alreadySeen) return;

    setVisible(true);
    const timer = window.setTimeout(() => {
      setVisible(false);
    }, 1250);

    return () => window.clearTimeout(timer);
  }, [reduced]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="clipper-preloader"
          initial={{ clipPath: 'inset(0% 0% 0% 0%)', opacity: 1 }}
          animate={{ clipPath: 'inset(0% 0% 0% 0%)', opacity: 1 }}
          exit={{
            clipPath: 'inset(0% 0% 100% 0%)',
            opacity: 0,
            transition: { duration: 0.45, ease: MOTION_EASE },
          }}
          className="fixed inset-0 z-[120] flex flex-col items-center justify-center bg-[#1A1A2E] text-white select-none"
          aria-live="polite"
          aria-label="Loading Clipper Studio"
        >
          <motion.div
            initial={{ scale: 0.84, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={MOTION_SPRING}
            className="flex flex-col items-center gap-4"
          >
            <div className="relative flex h-20 w-20 items-center justify-center rounded-[24px] bg-gradient-to-br from-[#6C63FF] via-[#8B84FF] to-[#FF5FA2] shadow-[0_18px_48px_rgba(108,99,255,0.45)]">
              <motion.svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                animate={{ rotate: [0, -6, 6, 0] }}
                transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
              >
                <circle cx="6" cy="6" r="3" />
                <path d="M8.12 8.12 12 12" />
                <path d="M20 4 8.12 15.88" />
                <circle cx="6" cy="18" r="3" />
                <path d="M14.8 14.8 20 20" />
              </motion.svg>
            </div>
            <div className="text-center">
              <p className="text-xl font-extrabold tracking-tight">Clipper Studio</p>
              <p className="mt-1 text-xs font-medium tracking-widest uppercase text-white/60">
                Booting AI Clip Engine
              </p>
            </div>
            <div className="mt-2 h-1.5 w-44 overflow-hidden rounded-full bg-white/15">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-[#6C63FF] via-[#FFD43B] to-[#FF8A30]"
                initial={{ width: '10%' }}
                animate={{ width: '100%' }}
                transition={{ duration: 1.15, ease: MOTION_EASE }}
              />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
