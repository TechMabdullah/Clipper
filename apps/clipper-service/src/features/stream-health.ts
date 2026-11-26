import { type StreamSnapshotRecord } from '../db.js';

export type HealthTrend = 'rising' | 'falling' | 'stable';

export interface StreamHealthResult {
  score: number;
  trend: HealthTrend;
  avgVelocity: number;
  peakVelocity: number;
}

/**
 * Scores the health of a stream session using its recent snapshots.
 * Uses up to the last 20 snapshots to compute a linear velocity trend.
 * Returns a score 0-100 and a trend direction.
 */
export function scoreStreamHealth(snapshots: StreamSnapshotRecord[]): StreamHealthResult {
  if (snapshots.length === 0) {
    return { score: 0, trend: 'stable', avgVelocity: 0, peakVelocity: 0 };
  }

  // Use up to the last 20 snapshots
  const recent = snapshots.slice(-20);
  const velocities = recent.map((s) => s.velocity);

  const avgVelocity = velocities.reduce((sum, v) => sum + v, 0) / velocities.length;
  const peakVelocity = Math.max(...velocities);

  // Linear trend: compare first half avg vs second half avg
  let trend: HealthTrend = 'stable';
  if (recent.length >= 4) {
    const half = Math.floor(recent.length / 2);
    const firstHalf = velocities.slice(0, half);
    const secondHalf = velocities.slice(half);
    const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
    const delta = secondAvg - firstAvg;
    if (delta > 0.5) {
      trend = 'rising';
    } else if (delta < -0.5) {
      trend = 'falling';
    }
  }

  // Score: normalize avgVelocity to 0-100 (cap at 100 messages/min as ceiling)
  const MAX_VELOCITY = 100;
  const rawScore = Math.min(1, avgVelocity / MAX_VELOCITY) * 100;

  // Trend bonus/penalty
  let score = rawScore;
  if (trend === 'rising') score = Math.min(100, score + 10);
  if (trend === 'falling') score = Math.max(0, score - 10);

  return {
    score: Math.round(score),
    trend,
    avgVelocity,
    peakVelocity,
  };
}
