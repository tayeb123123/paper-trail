/**
 * Proximity clustering ("hot spots").
 *
 * Given matches sorted by position, a single left-to-right sweep groups
 * matches whose gap to the previous match is ≤ `window` characters.
 * Groups that contain at least `minDistinct` different terms are reported.
 *
 * Score favours (1) more distinct terms, (2) more matches, (3) tighter span.
 * O(matches) time.
 */
import type { Match } from './search';

export interface ClusterOptions {
  /** max gap (normalized chars) between neighbouring matches */
  window: number;
  /** minimum number of distinct term groups in a cluster */
  minDistinct: number;
  /** minimum number of matches in a cluster (default 2) */
  minMatches?: number;
}

export interface Cluster {
  start: number;
  end: number;
  matches: Match[];
  /** distinct term-group indices, in order of first appearance */
  groups: number[];
  score: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = { window: 160, minDistinct: 2 };

export function findClusters(matches: Match[], opts: ClusterOptions = DEFAULT_CLUSTER_OPTIONS): Cluster[] {
  const clusters: Cluster[] = [];
  if (matches.length === 0) return clusters;

  let bucket: Match[] = [matches[0]];
  const flush = () => {
    const groups: number[] = [];
    for (const m of bucket) if (!groups.includes(m.group)) groups.push(m.group);
    if (groups.length >= opts.minDistinct && bucket.length >= (opts.minMatches ?? 2)) {
      const start = bucket[0].start;
      const end = Math.max(...bucket.map((m) => m.end));
      const span = Math.max(1, end - start);
      // density: matches per 100 chars, dampened so distinct-count dominates
      const density = (bucket.length / span) * 100;
      const score = groups.length * 10 + Math.min(bucket.length, 20) + Math.min(density, 10);
      clusters.push({ start, end, matches: bucket, groups, score: Math.round(score * 10) / 10 });
    }
  };

  for (let i = 1; i < matches.length; i++) {
    const prev = bucket[bucket.length - 1];
    const cur = matches[i];
    if (cur.start - prev.end <= opts.window) {
      bucket.push(cur);
    } else {
      flush();
      bucket = [cur];
    }
  }
  flush();

  return clusters.sort((a, b) => b.score - a.score || a.start - b.start);
}
