'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { MOTION_SPRING } from '@/lib/motion';
import type { DoodleFocusField, DoodleMood } from '@/stores/doodle-store';

function resolveBubbleMessage(mood: DoodleMood, focusedField: DoodleFocusField, customError?: string): string {
  if (mood === 'sad') {
    return customError || 'Hmm, that code or password didn’t match. Try again!';
  }
  if (mood === 'covering') {
    return 'Hands over eyes! Your secret stays totally private.';
  }
  if (mood === 'happy') {
    return 'Woohoo! Everything checks out — launching workspace!';
  }
  if (mood === 'typing') {
    if (focusedField === 'password' || focusedField === 'confirm') {
      return 'Watching politely… password masked tight.';
    }
    if (focusedField === 'name') {
      return 'Nice to meet you, creator!';
    }
    return 'Looking sharp! Ready whenever you are.';
  }
  return 'Drop a stream, cut viral shorts, publish everywhere.';
}

export function SpeechBubble({
  mood,
  focusedField,
  customError,
}: {
  mood: DoodleMood;
  focusedField: DoodleFocusField;
  customError?: string;
}) {
  const text = resolveBubbleMessage(mood, focusedField, customError);

  return (
    <div className="relative min-h-[54px] flex items-center justify-center">
      <AnimatePresence mode="wait">
        <motion.div
          key={`${mood}:${focusedField}:${customError ? 'err' : 'ok'}`}
          initial={{ opacity: 0, y: 6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.96 }}
          transition={MOTION_SPRING}
          className="relative max-w-xs rounded-[18px] border border-white/20 bg-white/95 dark:bg-[#1A1A2E]/95 px-4 py-2.5 text-center text-xs font-bold text-[#1A1A2E] dark:text-white shadow-[var(--shadow-2)]"
        >
          <span>{text}</span>
          <span
            aria-hidden="true"
            className="absolute -bottom-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-white/20 bg-white/95 dark:bg-[#1A1A2E]/95"
          />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
