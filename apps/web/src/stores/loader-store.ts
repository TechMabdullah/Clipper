'use client';

import { create } from 'zustand';

interface LoaderState {
  activeCount: number;
  visible: boolean;
  message: string;
  shownAtMs: number;
  begin: (message?: string) => number;
  finish: (startedAt: number) => Promise<void>;
  forceHide: () => void;
}

const MIN_VISIBLE_MS = 600;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

export const useLoader = create<LoaderState>((set, get) => ({
  activeCount: 0,
  visible: false,
  message: 'Working on it...',
  shownAtMs: 0,

  begin: (message = 'Processing...') => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    const now = Date.now();
    set((s) => ({
      activeCount: s.activeCount + 1,
      visible: true,
      message,
      shownAtMs: s.activeCount === 0 ? now : s.shownAtMs || now,
    }));
    return now;
  },

  finish: async (startedAt: number) => {
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, MIN_VISIBLE_MS - elapsed);
    if (remaining > 0) {
      await new Promise((r) => setTimeout(r, remaining));
    }
    set((s) => {
      const next = Math.max(0, s.activeCount - 1);
      return {
        activeCount: next,
        visible: next > 0,
        shownAtMs: next > 0 ? s.shownAtMs : 0,
      };
    });
  },

  forceHide: () => {
    set({ activeCount: 0, visible: false, shownAtMs: 0 });
  },
}));

/**
 * Guarantees the global loader is displayed for at least 600ms and ALWAYS hidden
 * inside `finally`, even when the wrapped async action rejects.
 */
export async function withLoader<T>(
  fn: () => Promise<T>,
  message = 'Loading...',
): Promise<T> {
  const startedAt = useLoader.getState().begin(message);
  try {
    return await fn();
  } finally {
    await useLoader.getState().finish(startedAt);
  }
}
