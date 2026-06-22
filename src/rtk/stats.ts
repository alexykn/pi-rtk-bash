export type RtkBashStats = {
  alreadyRtk: number;
  fallbackByReason: Record<string, number>;
  missingRtkErrors: number;
  passthroughs: number;
  pureExecutions: number;
  rewriteFailures: number;
  rewriteBySource: Record<string, number>;
  rewrites: number;
};

export function createRtkBashStats(): RtkBashStats {
  return {
    alreadyRtk: 0,
    fallbackByReason: {},
    missingRtkErrors: 0,
    passthroughs: 0,
    pureExecutions: 0,
    rewriteFailures: 0,
    rewriteBySource: {},
    rewrites: 0,
  };
}

export function incrementFallback(stats: RtkBashStats, reason: string): void {
  stats.fallbackByReason[reason] = (stats.fallbackByReason[reason] ?? 0) + 1;
}
