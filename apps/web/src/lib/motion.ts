export const MOTION_DURATION = {
  fastMs: 150,
  baseMs: 250,
  slowMs: 450,
  fast: 0.15,
  base: 0.25,
  slow: 0.45,
} as const;

export const MOTION_EASE = [0.22, 1, 0.36, 1] as const;

export const MOTION_SPRING = {
  type: 'spring' as const,
  stiffness: 260,
  damping: 22,
};

/** Controls when the doodle characters cover their eyes on /login & /signup. */
export const COVER_WHEN = 'shown' as const;

export const FADE_UP_VARIANTS = {
  hidden: { opacity: 0, y: 8 },
  visible: (index = 0) => ({
    opacity: 1,
    y: 0,
    transition: {
      duration: MOTION_DURATION.base,
      ease: MOTION_EASE,
      delay: Math.min(index * 0.04, 0.32),
    },
  }),
};

export const PAGE_TRANSITION_VARIANTS = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: MOTION_DURATION.base, ease: MOTION_EASE },
  },
  exit: {
    opacity: 0,
    y: -6,
    transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE },
  },
};
