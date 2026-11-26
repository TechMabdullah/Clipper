'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { PAGE_TRANSITION_VARIANTS } from '@/lib/motion';

export function PageTransition({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();

  if (reduced) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      variants={PAGE_TRANSITION_VARIANTS}
      initial="initial"
      animate="animate"
      exit="exit"
      className={className}
    >
      {children}
    </motion.div>
  );
}
