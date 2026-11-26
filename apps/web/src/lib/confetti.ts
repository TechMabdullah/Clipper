import confetti from 'canvas-confetti';

/**
 * Trigger celebratory multi-cannon fireworks confetti.
 */
export function triggerCelebrationConfetti() {
  if (typeof window === 'undefined') return;

  const count = 200;
  const defaults = {
    origin: { y: 0.7 },
    zIndex: 9999,
  };

  function fire(particleRatio: number, opts: confetti.Options) {
    confetti({
      ...defaults,
      ...opts,
      particleCount: Math.floor(count * particleRatio),
    });
  }

  fire(0.25, {
    spread: 26,
    startVelocity: 55,
    colors: ['#6C63FF', '#FF8A30', '#FF5FA2'],
  });
  fire(0.2, {
    spread: 60,
    colors: ['#FFD43B', '#6C63FF', '#1A1A2E'],
  });
  fire(0.35, {
    spread: 100,
    decay: 0.91,
    scalar: 0.8,
    colors: ['#6C63FF', '#FF8A30', '#FF5FA2', '#FFD43B'],
  });
  fire(0.1, {
    spread: 120,
    startVelocity: 25,
    decay: 0.92,
    scalar: 1.2,
    colors: ['#6C63FF', '#FF5FA2'],
  });
  fire(0.1, {
    spread: 120,
    startVelocity: 45,
    colors: ['#FF8A30', '#FFD43B'],
  });
}

/**
 * Trigger a localized spark burst around an interactive element.
 */
export function triggerSuccessBurst(clientX?: number, clientY?: number) {
  if (typeof window === 'undefined') return;

  const origin =
    clientX !== undefined && clientY !== undefined
      ? { x: Math.max(0, Math.min(1, clientX / window.innerWidth)), y: Math.max(0, Math.min(1, clientY / window.innerHeight)) }
      : { x: 0.5, y: 0.5 };

  confetti({
    particleCount: 50,
    spread: 70,
    origin,
    zIndex: 9999,
    colors: ['#6C63FF', '#FF8A30', '#FF5FA2', '#FFD43B'],
    disableForReducedMotion: true,
  });
}
