'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

/**
 * Concentric expanding radar wave ripples for active live broadcasts or background tasks.
 */
export function LivePulseRadar({
  className,
  size = 'md',
  color = 'red',
}: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  color?: 'red' | 'primary' | 'orange';
}) {
  const reduced = useReducedMotion();

  const colorStyles = {
    red: {
      dot: 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.7)]',
      ring: 'border-red-500/60 bg-red-500/20',
    },
    primary: {
      dot: 'bg-primary shadow-[0_0_10px_rgba(108,99,255,0.7)]',
      ring: 'border-primary/60 bg-primary/20',
    },
    orange: {
      dot: 'bg-[#FF8A30] shadow-[0_0_10px_rgba(255,138,48,0.7)]',
      ring: 'border-[#FF8A30]/60 bg-[#FF8A30]/20',
    },
  }[color];

  const sizeClass = {
    sm: 'h-2 w-2',
    md: 'h-2.5 w-2.5',
    lg: 'h-3.5 w-3.5',
  }[size];

  return (
    <span className={cn('relative inline-flex items-center justify-center', className)}>
      {/* Expanding Ripple 1 */}
      {!reduced && (
        <motion.span
          className={cn('absolute inset-0 rounded-full border', colorStyles.ring)}
          animate={{ scale: [1, 2.4], opacity: [0.8, 0] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
        />
      )}

      {/* Expanding Ripple 2 */}
      {!reduced && (
        <motion.span
          className={cn('absolute inset-0 rounded-full border', colorStyles.ring)}
          animate={{ scale: [1, 2.8], opacity: [0.6, 0] }}
          transition={{ duration: 1.8, delay: 0.6, repeat: Infinity, ease: 'easeOut' }}
        />
      )}

      {/* Solid Center Core */}
      <span className={cn('relative rounded-full', sizeClass, colorStyles.dot)} />
    </span>
  );
}

/**
 * Animated equalizer visualizer bars bouncing dynamically.
 */
export function AudioEqualizerBars({
  active = true,
  className,
}: {
  active?: boolean;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const heights = [
    [0.3, 0.9, 0.4, 0.8, 0.3],
    [0.7, 0.3, 0.8, 0.2, 0.7],
    [0.4, 1.0, 0.5, 0.9, 0.4],
    [0.6, 0.4, 0.9, 0.3, 0.6],
  ];

  return (
    <div className={cn('flex items-end gap-1 h-4 select-none', className)}>
      {[0, 1, 2, 3].map((i) => (
        <motion.span
          key={i}
          className="w-1 rounded-full bg-primary"
          animate={
            active && !reduced
              ? { scaleY: heights[i] }
              : { scaleY: 0.25 }
          }
          transition={{
            duration: 0.6 + i * 0.1,
            repeat: Infinity,
            repeatType: 'reverse',
            ease: 'easeInOut',
          }}
          style={{ originY: 1, height: '100%' }}
        />
      ))}
    </div>
  );
}

/**
 * Animated Sparkle icon badge for high virality clips or highlights.
 */
export function SparkleBadge({ text = 'Viral Pick', score }: { text?: string; score?: number }) {
  const reduced = useReducedMotion();

  return (
    <motion.span
      whileHover={reduced ? undefined : { scale: 1.05 }}
      whileTap={reduced ? undefined : { scale: 0.96 }}
      className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-primary/15 via-[#FF8A30]/15 to-[#FF5FA2]/15 px-3 py-1 text-xs font-bold text-primary border border-primary/20 shadow-sm cursor-default"
    >
      <motion.span
        animate={reduced ? undefined : { rotate: [0, 15, -15, 0], scale: [1, 1.2, 1] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
      >
        ✨
      </motion.span>
      <span>{text}</span>
      {score !== undefined && (
        <span className="ml-1 rounded-full bg-primary px-1.5 py-0.2 text-[10px] text-white font-extrabold">
          {score}
        </span>
      )}
    </motion.span>
  );
}
