'use client';

import { create } from 'zustand';
import { COVER_WHEN } from '@/lib/motion';

export type DoodleMood = 'idle' | 'typing' | 'covering' | 'sad' | 'happy';
export type DoodleFocusField = 'none' | 'email' | 'password' | 'name' | 'confirm';

interface DoodleState {
  mood: DoodleMood;
  focusedField: DoodleFocusField;
  passwordVisible: boolean;
  pointerX: number;
  pointerY: number;
  shakeKey: number;
  setPointer: (clientX: number, clientY: number) => void;
  setFocusedField: (field: DoodleFocusField) => void;
  setPasswordVisible: (visible: boolean) => void;
  setTyping: (typing: boolean) => void;
  triggerWrongPassword: () => void;
  triggerSuccess: () => void;
  reset: () => void;
}

let sadResetTimer: ReturnType<typeof setTimeout> | null = null;

export const useDoodleStore = create<DoodleState>((set, get) => ({
  mood: 'idle',
  focusedField: 'none',
  passwordVisible: false,
  pointerX: 0.5,
  pointerY: 0.5,
  shakeKey: 0,

  setPointer: (clientX, clientY) => {
    if (typeof window === 'undefined') return;
    const x = Math.min(1, Math.max(0, clientX / Math.max(1, window.innerWidth)));
    const y = Math.min(1, Math.max(0, clientY / Math.max(1, window.innerHeight)));
    set({ pointerX: x, pointerY: y });
  },

  setFocusedField: (field) => {
    const { passwordVisible, mood } = get();
    if (mood === 'happy') return;
    const shouldCover = passwordVisible && COVER_WHEN === 'shown';
    set({
      focusedField: field,
      mood: shouldCover ? 'covering' : field === 'none' ? 'idle' : 'typing',
    });
  },

  setPasswordVisible: (visible) => {
    const { focusedField } = get();
    const shouldCover = visible && COVER_WHEN === 'shown';
    set({
      passwordVisible: visible,
      mood: shouldCover ? 'covering' : focusedField !== 'none' ? 'typing' : 'idle',
    });
  },

  setTyping: (typing) => {
    const { passwordVisible, focusedField, mood } = get();
    if (mood === 'happy' || mood === 'sad') return;
    if (passwordVisible && COVER_WHEN === 'shown') {
      set({ mood: 'covering' });
      return;
    }
    set({ mood: typing || focusedField !== 'none' ? 'typing' : 'idle' });
  },

  triggerWrongPassword: () => {
    if (sadResetTimer) clearTimeout(sadResetTimer);
    set((s) => ({ mood: 'sad', shakeKey: s.shakeKey + 1 }));
    sadResetTimer = setTimeout(() => {
      const { passwordVisible, focusedField, mood } = get();
      if (mood !== 'sad') return;
      const shouldCover = passwordVisible && COVER_WHEN === 'shown';
      set({
        mood: shouldCover ? 'covering' : focusedField !== 'none' ? 'typing' : 'idle',
      });
    }, 1800);
  },

  triggerSuccess: () => {
    if (sadResetTimer) clearTimeout(sadResetTimer);
    set({ mood: 'happy' });
  },

  reset: () => {
    if (sadResetTimer) clearTimeout(sadResetTimer);
    set({
      mood: 'idle',
      focusedField: 'none',
      passwordVisible: false,
      pointerX: 0.5,
      pointerY: 0.5,
    });
  },
}));
