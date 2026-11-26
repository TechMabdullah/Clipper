'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Scissors } from 'lucide-react';
import { useDoodleStore } from '@/stores/doodle-store';
import { DoodleCharacters } from './doodle-characters';
import { SpeechBubble } from './speech-bubble';
import { triggerCelebrationConfetti } from '@/lib/confetti';

export function DoodleScene({ customError }: { customError?: string }) {
  const { mood, focusedField, pointerX, pointerY, setPointer } = useDoodleStore();
  const reduced = useReducedMotion();

  React.useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      setPointer(e.clientX, e.clientY);
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [setPointer]);

  // Celebrate with confetti when mood turns happy
  React.useEffect(() => {
    if (mood === 'happy') {
      try {
        triggerCelebrationConfetti();
      } catch {}
    }
  }, [mood]);

  return (
    <div className="relative flex flex-col justify-between overflow-hidden rounded-[26px] bg-gradient-to-br from-[#6C63FF]/14 via-[#FF8A30]/10 to-[#FF5FA2]/14 p-6 sm:p-8 border border-primary/15 min-h-[300px] lg:min-h-[540px]">
      {/* Ambient floating sparkle particles */}
      {!reduced && (
        <>
          <motion.div
            className="absolute top-10 right-12 text-sm select-none pointer-events-none"
            animate={{
              y: [0, -8, 0],
              rotate: [0, 15, -15, 0],
              opacity: [0.4, 0.9, 0.4],
            }}
            transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
          >
            ✨
          </motion.div>
          <motion.div
            className="absolute bottom-16 left-8 text-xs select-none pointer-events-none"
            animate={{
              y: [0, 6, 0],
              scale: [0.8, 1.15, 0.8],
              opacity: [0.3, 0.8, 0.3],
            }}
            transition={{ duration: 4.2, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
          >
            ⭐
          </motion.div>
          <motion.div
            className="absolute top-28 left-10 text-xs select-none pointer-events-none text-primary"
            animate={{
              scale: [1, 1.3, 1],
              opacity: [0.3, 0.7, 0.3],
            }}
            transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut', delay: 0.5 }}
          >
            ✦
          </motion.div>
        </>
      )}

      <div className="flex items-center gap-2.5 relative z-10">
        <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-primary text-white shadow-[var(--shadow-sm)]">
          <Scissors className="h-5 w-5" />
        </div>
        <div>
          <p className="text-base font-extrabold tracking-tight text-foreground">Clipper Studio</p>
          <p className="text-xs font-medium text-muted-foreground">AI Clip & Creator OS</p>
        </div>
      </div>

      <div className="my-4 flex flex-col items-center justify-center gap-3 relative z-10">
        <SpeechBubble mood={mood} focusedField={focusedField} customError={customError} />
        <DoodleCharacters
          mood={mood}
          focusedField={focusedField}
          pointerX={pointerX}
          pointerY={pointerY}
        />
      </div>

      <div className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground relative z-10">
        <span>Firebase + 2FA Email OTP</span>
        <span className="text-primary font-bold">Playful Security</span>
      </div>
    </div>
  );
}
