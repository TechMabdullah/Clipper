import { getAbExperiment, recordAbView, recordAbClick } from '../db.js';

export type AbVariant = 'a' | 'b';

export interface AbExperimentRecord {
  id: string;
  clip_id: string;
  variant_a_title: string;
  variant_b_title: string;
  variant_a_views: number;
  variant_b_views: number;
  variant_a_clicks: number;
  variant_b_clicks: number;
  created_at: number;
}

/**
 * Returns the active variant for a given clip via round-robin:
 * 'a' when total views is even, 'b' when odd.
 */
export function getActiveVariant(clipId: string): AbVariant {
  const exp = getAbExperiment(clipId);
  if (!exp) return 'a';
  const totalViews = exp.variant_a_views + exp.variant_b_views;
  return totalViews % 2 === 0 ? 'a' : 'b';
}

/**
 * Computes the winner of an A/B experiment based on click-through rate.
 */
export function computeAbWinner(exp: AbExperimentRecord): {
  winner: 'a' | 'b' | 'tie';
  ctrA: number;
  ctrB: number;
} {
  const ctrA = exp.variant_a_views > 0 ? exp.variant_a_clicks / exp.variant_a_views : 0;
  const ctrB = exp.variant_b_views > 0 ? exp.variant_b_clicks / exp.variant_b_views : 0;

  let winner: 'a' | 'b' | 'tie';
  if (ctrA > ctrB) {
    winner = 'a';
  } else if (ctrB > ctrA) {
    winner = 'b';
  } else {
    winner = 'tie';
  }

  return { winner, ctrA, ctrB };
}

export { recordAbView, recordAbClick };
