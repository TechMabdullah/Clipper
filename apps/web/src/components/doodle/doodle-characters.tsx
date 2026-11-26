'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { MOTION_SPRING } from '@/lib/motion';
import type { DoodleFocusField, DoodleMood } from '@/stores/doodle-store';

function getFieldTargetOffsets(field: DoodleFocusField): { x: number; y: number } {
  switch (field) {
    case 'name':
      return { x: 0.72, y: 0.35 };
    case 'email':
      return { x: 0.78, y: 0.48 };
    case 'password':
    case 'confirm':
      return { x: 0.78, y: 0.65 };
    default:
      return { x: 0.5, y: 0.5 };
  }
}

export function DoodleCharacters({
  mood,
  focusedField,
  pointerX,
  pointerY,
}: {
  mood: DoodleMood;
  focusedField: DoodleFocusField;
  pointerX: number;
  pointerY: number;
}) {
  const reduced = useReducedMotion();
  const [blinking, setBlinking] = React.useState(false);

  // Subtle ambient blink every ~4.2s
  React.useEffect(() => {
    if (reduced || mood === 'covering' || mood === 'happy') return;
    const interval = window.setInterval(() => {
      setBlinking(true);
      window.setTimeout(() => setBlinking(false), 140);
    }, 4200);
    return () => window.clearInterval(interval);
  }, [reduced, mood]);

  const activeTarget =
    focusedField !== 'none' ? getFieldTargetOffsets(focusedField) : { x: pointerX, y: pointerY };

  // Clamped pupil offsets in SVG coordinates
  const pupilDx = reduced ? 0 : (activeTarget.x - 0.5) * 6.5;
  const pupilDy =
    mood === 'sad'
      ? 2.8
      : reduced
        ? 0
        : (activeTarget.y - 0.5) * 4.5 + (mood === 'typing' ? 1.5 : 0);

  const bodyLean = reduced ? 0 : (activeTarget.x - 0.5) * 7;

  const isCovering = mood === 'covering';
  const isSad = mood === 'sad';
  const isHappy = mood === 'happy';

  const headSadAnim = isSad && !reduced ? { rotate: [0, -10, 10, -8, 6, 0] } : { rotate: 0 };
  const happyJumpAnim = isHappy && !reduced ? { y: [0, -16, 0, -10, 0] } : { y: 0 };

  return (
    <motion.svg
      viewBox="0 0 380 250"
      className="w-full max-w-[360px] h-auto select-none overflow-visible"
      role="img"
      aria-label="Playful animated studio companion characters"
      animate={isHappy ? happyJumpAnim : headSadAnim}
      transition={
        isSad
          ? { duration: 1.15, ease: 'easeInOut' }
          : isHappy
            ? { duration: 0.75, ease: 'easeOut' }
            : MOTION_SPRING
      }
    >
      {/* Ground shadow */}
      <ellipse cx="190" cy="236" rx="145" ry="12" fill="rgba(26,26,46,0.16)" />

      {/* 1. Navy Tall Studio Block (#1A1A2E) back-right */}
      <motion.g
        animate={{ x: bodyLean * 0.45, y: mood === 'idle' && !reduced ? [0, -2, 0] : 0 }}
        whileHover={reduced ? undefined : { scale: 1.05, y: -6 }}
        whileTap={reduced ? undefined : { scale: 0.95 }}
        style={{ transformOrigin: '244px 226px', cursor: 'pointer' }}
        transition={{ y: { duration: 3.6, repeat: Infinity, ease: 'easeInOut' }, x: MOTION_SPRING }}
      >
        <rect x="206" y="48" width="76" height="178" rx="22" fill="#1A1A2E" />
        {/* Eyes */}
        {!isCovering && (
          <g>
            <ellipse
              cx="231"
              cy="96"
              rx="8"
              ry={blinking ? 1.5 : isHappy ? 2.5 : 8}
              fill="#FFFFFF"
            />
            <ellipse
              cx="257"
              cy="96"
              rx="8"
              ry={blinking ? 1.5 : isHappy ? 2.5 : 8}
              fill="#FFFFFF"
            />
            {!blinking && !isHappy && (
              <>
                <circle cx={231 + pupilDx * 0.65} cy={96 + pupilDy * 0.65} r="4" fill="#6C63FF" />
                <circle cx={257 + pupilDx * 0.65} cy={96 + pupilDy * 0.65} r="4" fill="#6C63FF" />
              </>
            )}
          </g>
        )}
        {/* Covering hands */}
        <motion.g
          initial={false}
          animate={{ y: isCovering ? 0 : 48, opacity: isCovering ? 1 : 0 }}
          transition={MOTION_SPRING}
        >
          <rect x="218" y="84" width="22" height="22" rx="11" fill="#6C63FF" />
          <rect x="247" y="84" width="22" height="22" rx="11" fill="#6C63FF" />
        </motion.g>
        {/* Mouth */}
        {isSad ? (
          <path d="M234 124 Q244 116 254 124" stroke="#FF5FA2" strokeWidth="3.5" strokeLinecap="round" fill="none" />
        ) : isHappy ? (
          <path d="M232 117 Q244 130 256 117" stroke="#FFD43B" strokeWidth="3.5" strokeLinecap="round" fill="none" />
        ) : (
          <path d="M235 120 Q244 125 253 120" stroke="#9CA0BD" strokeWidth="3" strokeLinecap="round" fill="none" />
        )}
      </motion.g>

      {/* 2. Tall Purple Pill Character (#6C63FF) main left */}
      <motion.g
        animate={{ x: bodyLean * 0.7, y: mood === 'idle' && !reduced ? [0, -4, 0] : 0 }}
        whileHover={reduced ? undefined : { scale: 1.05, y: -8 }}
        whileTap={reduced ? undefined : { scale: 0.95 }}
        style={{ transformOrigin: '140px 226px', cursor: 'pointer' }}
        transition={{ y: { duration: 3, repeat: Infinity, ease: 'easeInOut' }, x: MOTION_SPRING }}
      >
        <rect x="92" y="28" width="96" height="198" rx="48" fill="#6C63FF" />
        <rect x="104" y="40" width="24" height="58" rx="12" fill="rgba(255,255,255,0.14)" />
        {/* Eyes */}
        {!isCovering && (
          <g>
            <ellipse
              cx="124"
              cy="86"
              rx="11"
              ry={blinking ? 1.5 : isHappy ? 3 : 11}
              fill="#FFFFFF"
            />
            <ellipse
              cx="156"
              cy="86"
              rx="11"
              ry={blinking ? 1.5 : isHappy ? 3 : 11}
              fill="#FFFFFF"
            />
            {!blinking && !isHappy && (
              <>
                <circle cx={124 + pupilDx} cy={86 + pupilDy} r="5.2" fill="#1A1A2E" />
                <circle cx={125.5 + pupilDx} cy={84.5 + pupilDy} r="1.6" fill="#FFFFFF" />
                <circle cx={156 + pupilDx} cy={86 + pupilDy} r="5.2" fill="#1A1A2E" />
                <circle cx={157.5 + pupilDx} cy={84.5 + pupilDy} r="1.6" fill="#FFFFFF" />
              </>
            )}
          </g>
        )}
        {/* Teardrop on sad */}
        {isSad && (
          <motion.path
            d="M112 96 C108 104 116 108 112 114"
            stroke="#93C5FD"
            strokeWidth="4"
            strokeLinecap="round"
            fill="none"
            animate={{ opacity: [0, 1, 0], y: [0, 14] }}
            transition={{ duration: 0.9, repeat: Infinity }}
          />
        )}
        {/* Arms covering eyes smoothly when password visible */}
        <motion.g
          initial={false}
          animate={{ y: isCovering ? 0 : 60, opacity: isCovering ? 1 : 0 }}
          transition={MOTION_SPRING}
        >
          <rect x="108" y="72" width="28" height="28" rx="14" fill="#544BE8" stroke="#FFFFFF" strokeWidth="2.5" />
          <rect x="144" y="72" width="28" height="28" rx="14" fill="#544BE8" stroke="#FFFFFF" strokeWidth="2.5" />
        </motion.g>
        {/* Mouth */}
        {isSad ? (
          <path d="M128 118 Q140 107 152 118" stroke="#1A1A2E" strokeWidth="4" strokeLinecap="round" fill="none" />
        ) : isHappy ? (
          <path d="M126 110 Q140 128 154 110 Z" fill="#1A1A2E" />
        ) : (
          <path d="M131 112 Q140 120 149 112" stroke="#1A1A2E" strokeWidth="3.5" strokeLinecap="round" fill="none" />
        )}
      </motion.g>

      {/* 3. Yellow Circle Buddy (#FFD43B) right side */}
      <motion.g
        animate={{
          x: bodyLean * 0.85,
          y: mood === 'idle' && !reduced ? [0, -5, 0] : 0,
          rotate: isCovering ? 22 : 0,
        }}
        whileHover={reduced ? undefined : { scale: 1.12, rotate: [-2, 6, -4, 0] }}
        whileTap={reduced ? undefined : { scale: 0.92 }}
        style={{ originX: '304px', originY: '165px', cursor: 'pointer' }}
        transition={{ y: { duration: 2.6, repeat: Infinity, ease: 'easeInOut' }, rotate: MOTION_SPRING }}
      >
        <circle cx="304" cy="166" r="46" fill="#FFD43B" />
        <circle cx="288" cy="176" r="6" fill="rgba(255,95,162,0.35)" />
        <circle cx="320" cy="176" r="6" fill="rgba(255,95,162,0.35)" />
        {!isCovering ? (
          <g>
            <circle cx="290" cy="158" r={blinking ? 1.5 : 6.5} fill="#1A1A2E" />
            <circle cx="318" cy="158" r={blinking ? 1.5 : 6.5} fill="#1A1A2E" />
            {!blinking && (
              <>
                <circle cx={290 + pupilDx * 0.45} cy={156.5 + pupilDy * 0.45} r="2.2" fill="#FFFFFF" />
                <circle cx={318 + pupilDx * 0.45} cy={156.5 + pupilDy * 0.45} r="2.2" fill="#FFFFFF" />
              </>
            )}
          </g>
        ) : (
          <g>
            <path d="M283 158 L295 162" stroke="#1A1A2E" strokeWidth="3.5" strokeLinecap="round" />
            <path d="M313 162 L325 158" stroke="#1A1A2E" strokeWidth="3.5" strokeLinecap="round" />
          </g>
        )}
        {isSad ? (
          <path d="M294 182 Q304 174 314 182" stroke="#1A1A2E" strokeWidth="3.5" strokeLinecap="round" fill="none" />
        ) : (
          <path d="M295 176 Q304 185 313 176" stroke="#1A1A2E" strokeWidth="3.5" strokeLinecap="round" fill="none" />
        )}
      </motion.g>

      {/* 4. Orange Half-Dome Blob (#FF8A30) foreground center-left */}
      <motion.g
        animate={{ x: bodyLean * 0.95, y: mood === 'idle' && !reduced ? [0, -2.5, 0] : 0 }}
        whileHover={reduced ? undefined : { scale: 1.08, y: -5 }}
        whileTap={reduced ? undefined : { scale: 0.95 }}
        style={{ transformOrigin: '111px 228px', cursor: 'pointer' }}
        transition={{ y: { duration: 2.8, repeat: Infinity, ease: 'easeInOut' }, x: MOTION_SPRING }}
      >
        <path
          d="M 48 228 C 48 158, 174 158, 174 228 Z"
          fill="#FF8A30"
        />
        {!isCovering && (
          <g>
            <ellipse cx="94" cy="192" rx="8.5" ry={blinking ? 1.5 : 8.5} fill="#FFFFFF" />
            <ellipse cx="128" cy="192" rx="8.5" ry={blinking ? 1.5 : 8.5} fill="#FFFFFF" />
            {!blinking && (
              <>
                <circle cx={94 + pupilDx * 0.65} cy={192 + pupilDy * 0.65} r="4.2" fill="#1A1A2E" />
                <circle cx={128 + pupilDx * 0.65} cy={192 + pupilDy * 0.65} r="4.2" fill="#1A1A2E" />
              </>
            )}
          </g>
        )}
        <motion.g
          initial={false}
          animate={{ y: isCovering ? 0 : 40, opacity: isCovering ? 1 : 0 }}
          transition={MOTION_SPRING}
        >
          <rect x="82" y="182" width="24" height="20" rx="10" fill="#EA6B10" stroke="#FFFFFF" strokeWidth="2" />
          <rect x="116" y="182" width="24" height="20" rx="10" fill="#EA6B10" stroke="#FFFFFF" strokeWidth="2" />
        </motion.g>
        {isSad ? (
          <path d="M101 214 Q111 206 121 214" stroke="#1A1A2E" strokeWidth="3.5" strokeLinecap="round" fill="none" />
        ) : (
          <path d="M102 208 Q111 217 120 208" stroke="#1A1A2E" strokeWidth="3.5" strokeLinecap="round" fill="none" />
        )}
      </motion.g>

      {/* Playful Pink Sparkle Accent (#FF5FA2) */}
      <motion.path
        d="M54 68 L58 80 L70 84 L58 88 L54 100 L50 88 L38 84 L50 80 Z"
        fill="#FF5FA2"
        animate={reduced ? undefined : { scale: [1, 1.15, 1], rotate: [0, 8, 0] }}
        transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
      />
    </motion.svg>
  );
}
