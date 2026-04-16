export interface BeliefSnapshot {
  id: string;
  topic: string;
  timestamp: number;
  namespace: string;
  totalBeliefs: number;
  established: number;
  contested: number;
  weak: number;
  contradictions: number;
  gaps: string[];
  resolvedGaps: string[];
  rounds: number;
  sources: number;
  judgeClarity: number;
  proClarity: number;
  antiClarity: number;
  verdictText: string;
  allSources: Array<{ title: string | null; url: string; query: string }>;
  allConflicts: Array<{ a: string; b: string }>;
}

export interface EvolvedBeliefSystem {
  topics: string[];
  totalDebates: number;
  cumulativeBeliefs: number;
  cumulativeSources: number;
  cumulativeContradictions: number;
  averageClarity: number;
  lastUpdated: number;
  snapshots: BeliefSnapshot[];
}

const STORAGE_KEY = 'debate_engine_beliefs';
const MAX_SNAPSHOTS = 20;

export function loadBeliefSystem(): EvolvedBeliefSystem {
  if (typeof window === 'undefined') return emptySystem();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptySystem();
    return JSON.parse(raw) as EvolvedBeliefSystem;
  } catch {
    return emptySystem();
  }
}

export function saveSnapshot(snapshot: BeliefSnapshot): EvolvedBeliefSystem {
  const system = loadBeliefSystem();
  const existingIdx = system.snapshots.findIndex(
    (s) => s.namespace === snapshot.namespace
  );
  if (existingIdx >= 0) {
    system.snapshots[existingIdx] = snapshot;
  } else {
    system.snapshots.unshift(snapshot);
    if (system.snapshots.length > MAX_SNAPSHOTS) {
      system.snapshots = system.snapshots.slice(0, MAX_SNAPSHOTS);
    }
  }
  system.topics = [...new Set(system.snapshots.map((s) => s.topic))];
  system.totalDebates = system.snapshots.length;
  system.cumulativeBeliefs = system.snapshots.reduce(
    (acc, s) => acc + s.totalBeliefs, 0
  );
  system.cumulativeSources = system.snapshots.reduce(
    (acc, s) => acc + s.sources, 0
  );
  system.cumulativeContradictions = system.snapshots.reduce(
    (acc, s) => acc + s.contradictions, 0
  );
  const clarities = system.snapshots
    .map((s) => s.judgeClarity)
    .filter((c) => c > 0);
  system.averageClarity =
    clarities.length > 0
      ? clarities.reduce((a, b) => a + b, 0) / clarities.length
      : 0;
  system.lastUpdated = Date.now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(system));
  } catch {
    system.snapshots = system.snapshots.slice(0, 10);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(system));
    } catch { /* silent */ }
  }
  return system;
}

export function deleteSnapshot(id: string): EvolvedBeliefSystem {
  const system = loadBeliefSystem();
  system.snapshots = system.snapshots.filter((s) => s.id !== id);
  system.topics = [...new Set(system.snapshots.map((s) => s.topic))];
  system.totalDebates = system.snapshots.length;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(system));
  } catch { /* silent */ }
  return system;
}

export function clearAllSnapshots(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

export function generateSnapshotId(): string {
  return `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptySystem(): EvolvedBeliefSystem {
  return {
    topics: [],
    totalDebates: 0,
    cumulativeBeliefs: 0,
    cumulativeSources: 0,
    cumulativeContradictions: 0,
    averageClarity: 0,
    lastUpdated: 0,
    snapshots: [],
  };
}
