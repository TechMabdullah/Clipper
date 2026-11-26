'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { MOTION_SPRING } from '@/lib/motion';

export interface MotionCardProps extends React.ComponentPropsWithoutRef<typeof Card> {
  enableTilt?: boolean;
  spotlight?: boolean;
  delay?: number;
}

export function MotionCard({
  className,
  children,
  enableTilt = true,
  spotlight = true,
  delay = 0,
  ...props
}: MotionCardProps) {
  const reduced = useReducedMotion();
  const [mousePos, setMousePos] = React.useState<{ x: number; y: number } | null>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (reduced || !spotlight || !cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    setMousePos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  const handleMouseLeave = () => {
    setMousePos(null);
  };

  return (
    <motion.div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        ...MOTION_SPRING,
        delay,
      }}
      whileHover={
        reduced
          ? undefined
          : {
              y: -4,
              scale: 1.012,
              transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
            }
      }
      whileTap={reduced ? undefined : { scale: 0.985 }}
      className="relative group transition-shadow duration-300 hover:shadow-[var(--shadow-md)] rounded-[24px]"
    >
      {/* Interactive Cursor Spotlight Glow */}
      {spotlight && mousePos && !reduced && (
        <div
          className="pointer-events-none absolute -inset-px rounded-[24px] opacity-100 transition-opacity duration-300"
          style={{
            background: `radial-gradient(400px circle at ${mousePos.x}px ${mousePos.y}px, rgba(108, 99, 255, 0.12), transparent 70%)`,
          }}
        />
      )}

      <Card
        className={cn(
          'relative overflow-hidden border-border/80 bg-card transition-colors duration-200 group-hover:border-primary/30',
          className,
        )}
        {...props}
      >
        {children}
      </Card>
    </motion.div>
  );
}
