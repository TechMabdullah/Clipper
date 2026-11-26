'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export function AmbientGlow() {
  const reduced = useReducedMotion();

  if (reduced) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden select-none"
    >
      {/* Orb 1: Primary purple */}
      <motion.div
        className="absolute -top-[15%] -left-[10%] h-[480px] w-[480px] rounded-full bg-[#6C63FF]/12 blur-[120px] dark:bg-[#6C63FF]/16"
        animate={{
          x: [0, 45, -20, 0],
          y: [0, 30, -35, 0],
          scale: [1, 1.12, 0.95, 1],
        }}
        transition={{
          duration: 18,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />

      {/* Orb 2: Vibrant Orange */}
      <motion.div
        className="absolute top-[35%] -right-[12%] h-[440px] w-[440px] rounded-full bg-[#FF8A30]/10 blur-[130px] dark:bg-[#FF8A30]/14"
        animate={{
          x: [0, -35, 25, 0],
          y: [0, -40, 20, 0],
          scale: [1, 0.92, 1.08, 1],
        }}
        transition={{
          duration: 22,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />

      {/* Orb 3: Playful Pink */}
      <motion.div
        className="absolute -bottom-[15%] left-[25%] h-[500px] w-[500px] rounded-full bg-[#FF5FA2]/8 blur-[140px] dark:bg-[#FF5FA2]/12"
        animate={{
          x: [0, 30, -30, 0],
          y: [0, -25, 30, 0],
          scale: [1, 1.06, 0.94, 1],
        }}
        transition={{
          duration: 20,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />
    </div>
  );
}
