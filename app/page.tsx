'use client';

import { useReducer, useRef, useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { DebateEvent, DebateConfig } from '@/src/types/debate';
import {
  loadBeliefSystem, saveSnapshot, deleteSnapshot,
  clearAllSnapshots, generateSnapshotId,
  type BeliefSnapshot, type EvolvedBeliefSystem,
} from '@/src/lib/persistence';

type Theme = 'dark' | 'light' | 'sepia';
const themes: Record<Theme, Record<string, string>> = {
  dark: {
    '--bg': '#09090b', '--bg-2': '#18181b', '--bg-3': '#27272a',
    '--border': '#3f3f46', '--text': '#f4f4f5', '--text-2': '#a1a1aa',
    '--text-3': '#71717a', '--text-4': '#52525b',
    '--pro': '#16a34a', '--pro-bg': 'rgba(22,101,52,0.12)', '--pro-border': '#14532d',
    '--anti': '#dc2626', '--anti-bg': 'rgba(127,29,29,0.12)', '--anti-border': '#7f1d1d',
    '--accent': '#67e8f9', '--accent-bg': 'rgba(8,145,178,0.08)',
    '--warn': '#f59e0b', '--warn-bg': 'rgba(120,53,15,0.15)', '--warn-border': '#92400e',
    '--green': '#4ade80', '--red': '#f87171',
  },
  light: {
    '--bg': '#fafafa', '--bg-2': '#ffffff', '--bg-3': '#f4f4f5',
    '--border': '#e4e4e7', '--text': '#18181b', '--text-2': '#52525b',
    '--text-3': '#71717a', '--text-4': '#a1a1aa',
    '--pro': '#15803d', '--pro-bg': 'rgba(20,83,45,0.06)', '--pro-border': '#bbf7d0',
    '--anti': '#b91c1c', '--anti-bg': 'rgba(127,29,29,0.06)', '--anti-border': '#fecaca',
    '--accent': '#0891b2', '--accent-bg': 'rgba(8,145,178,0.06)',
    '--warn': '#d97706', '--warn-bg': 'rgba(180,83,9,0.08)', '--warn-border': '#fde68a',
    '--green': '#16a34a', '--red': '#dc2626',
  },
  sepia: {
    '--bg': '#1c1714', '--bg-2': '#251f1a', '--bg-3': '#302820',
    '--border': '#4a3728', '--text': '#e8dcc8', '--text-2': '#b8a898',
    '--text-3': '#8c7968', '--text-4': '#6a5948',
    '--pro': '#7fb069', '--pro-bg': 'rgba(74,111,53,0.15)', '--pro-border': '#3a5a28',
    '--anti': '#c9715a', '--anti-bg': 'rgba(120,40,20,0.15)', '--anti-border': '#7a3020',
    '--accent': '#d4a843', '--accent-bg': 'rgba(180,130,40,0.10)',
    '--warn': '#e8a840', '--warn-bg': 'rgba(160,90,20,0.15)', '--warn-border': '#8a5820',
    '--green': '#88c070', '--red': '#d07060',
  },
};

type Source = { title: string | null; url: string };
type SideState = {
  angle: string; queries: string[]; sources: Source[];
  created: number; clarity: number; contradictions: number;
  conflictPairs: Array<{ a: string; b: string }>; done: boolean;
};
const emptySide = (): SideState => ({
  angle: '', queries: [], sources: [], created: 0,
  clarity: 0, contradictions: 0, conflictPairs: [], done: false,
});
type RoundState = {
  num: number; proLabel: string; antiLabel: string;
  reasoning: string; moveValue: number;
  pro: SideState; anti: SideState;
  proClarity: number; antiClarity: number;
  contradictions: number; resolvedGaps: string[]; done: boolean;
};
type JudgeState = {
  totalBeliefs: number; established: number; contested: number;
  weak: number; gaps: string[]; contradictionCount: number;
};
type ScorecardState = {
  proCreated: number; antiCreated: number; proClarity: number;
  antiClarity: number; contradictions: number; gaps: number;
  rounds: number; sources: number; judgeClarity: number;
};
type AppPhase = 'idle'|'configuring'|'running'|'judging'|'verdict'|'done'|'error';
type AppState = {
  phase: AppPhase; config: DebateConfig | null; namespace: string;
  maxRounds: number; goal: string; gaps: string[]; rounds: RoundState[];
  earlyExit: string | null; judgeState: JudgeState | null;
  verdictText: string; verdictDone: boolean;
  scorecard: ScorecardState | null; error: string | null;
};
const initialState: AppState = {
  phase: 'idle', config: null, namespace: '', maxRounds: 6,
  goal: '', gaps: [], rounds: [], earlyExit: null,
  judgeState: null, verdictText: '', verdictDone: false,
  scorecard: null, error: null,
};

function reducer(state: AppState, event: DebateEvent | { type: 'start_configuring' } | { type: 'reset' }): AppState {
  if (event.type === 'reset') return { ...initialState };
  if (event.type === 'start_configuring') return { ...initialState, phase: 'configuring' };
  switch (event.type) {
    case 'config_ready':
      return { ...state, config: event.config, namespace: event.namespace, maxRounds: event.config.maxRounds ?? 6, phase: 'configuring' };
    case 'seed_done':
      return { ...state, goal: event.goal, gaps: Array.from(new Set(event.gaps)), namespace: event.namespace, phase: 'running' };
    case 'round_start': {
      const newRound: RoundState = {
        num: event.round, proLabel: event.proLabel, antiLabel: event.antiLabel,
        reasoning: event.reasoning, moveValue: event.moveValue ?? 0,
        pro: { ...emptySide(), angle: event.proAngle },
        anti: { ...emptySide(), angle: event.antiAngle },
        proClarity: 0, antiClarity: 0, contradictions: 0, resolvedGaps: [], done: false,
      };
      return { ...state, rounds: [...state.rounds, newRound] };
    }
    case 'side_queries': {
      const rounds = state.rounds.map((r) =>
        r.num === state.rounds.at(-1)?.num ? { ...r, [event.side]: { ...r[event.side], queries: event.queries } } : r);
      return { ...state, rounds };
    }
    case 'side_sources': {
      const rounds = state.rounds.map((r) =>
        r.num === state.rounds.at(-1)?.num ? { ...r, [event.side]: { ...r[event.side], sources: event.sources } } : r);
      return { ...state, rounds };
    }
    case 'side_done': {
      const rounds = state.rounds.map((r) =>
        r.num === state.rounds.at(-1)?.num ? { ...r, [event.side]: { ...r[event.side], created: event.created, clarity: event.clarity, contradictions: event.contradictions, conflictPairs: event.conflictPairs ?? [], done: true } } : r);
      return { ...state, rounds };
    }
    case 'round_done': {
      const rounds = state.rounds.map((r) =>
        r.num === event.round ? { ...r, proClarity: event.proClarity, antiClarity: event.antiClarity, contradictions: event.contradictions, done: true } : r);
      return { ...state, rounds };
    }
    case 'gap_resolved': {
      const rounds = state.rounds.map((r, i) =>
        i === state.rounds.length - 1 ? { ...r, resolvedGaps: [...r.resolvedGaps, event.gap] } : r);
      return { ...state, rounds };
    }
    case 'early_exit': return { ...state, earlyExit: event.reason };
    case 'judge_state': return { ...state, judgeState: event, phase: 'judging' };
    case 'verdict_chunk': return { ...state, verdictText: state.verdictText + event.text, phase: 'verdict' };
    case 'verdict_done': return { ...state, verdictDone: true };
    case 'scorecard': return { ...state, scorecard: event };
    case 'done': return { ...state, phase: 'done' };
    case 'error': return { ...state, error: event.message, phase: 'error' };
    default: return state;
  }
}

function ClarityBar({ value, color }: { value: number; color: string }) {
  const pct = Math.min(100, Math.round(value * 100));
  return (
    <div className='flex items-center gap-2 text-xs'>
      <div className='h-1.5 rounded-full overflow-hidden' style={{ width: '6rem', background: 'var(--bg-3)' }}>
        <div className='h-full rounded-full clarity-bar' style={{ width: `${pct}%`, background: color }} />
      </div>
      <span style={{ color: 'var(--text-3)' }} className='tabular-nums'>{value.toFixed(3)}</span>
    </div>
  );
}

function Badge({ children, variant = 'default' }: { children: React.ReactNode; variant?: 'default'|'green'|'red'|'amber'|'cyan' }) {
  const styles: Record<string, React.CSSProperties> = {
    default: { background: 'var(--bg-3)', color: 'var(--text-3)' },
    green: { background: 'var(--pro-bg)', color: 'var(--pro)', border: '1px solid var(--pro-border)' },
    red: { background: 'var(--anti-bg)', color: 'var(--anti)', border: '1px solid var(--anti-border)' },
    amber: { background: 'var(--warn-bg)', color: 'var(--warn)', border: '1px solid var(--warn-border)' },
    cyan: { background: 'var(--accent-bg)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)' },
  };
  return <span className='inline-block text-xs px-1.5 py-0.5 rounded font-mono' style={styles[variant]}>{children}</span>;
}

function Spinner() {
  return <span className='inline-block w-3 h-3 rounded-full animate-spin' style={{ border: '2px solid var(--border)', borderTopColor: 'var(--text-2)' }} />;
}

function SideColumn({ side, data, label }: { side: 'pro'|'anti'; data: SideState; label: string }) {
  const isPro = side === 'pro';
  return (
    <div className='flex-1 min-w-0 rounded-lg p-3' style={{ border: `1px solid ${isPro ? 'var(--pro-border)' : 'var(--anti-border)'}`, background: isPro ? 'var(--pro-bg)' : 'var(--anti-bg)' }}>
      <div className='text-xs font-bold mb-2 flex items-center gap-2' style={{ color: isPro ? 'var(--pro)' : 'var(--anti)' }}>
        {label}{!data.done && data.queries.length > 0 && <Spinner />}
      </div>
      {data.angle && <p className='text-xs mb-2 italic' style={{ color: 'var(--text-2)' }}>{data.angle}</p>}
      {data.queries.length > 0 && (
        <div className='mb-2 space-y-1'>
          {data.queries.map((q, i) => (
            <div key={i} className='text-xs flex gap-1' style={{ color: 'var(--text-4)' }}>
              <span>{i + 1}.</span>
              <span className='italic truncate' title={q}>&ldquo;{q.slice(0, 80)}&rdquo;</span>
            </div>
          ))}
        </div>
      )}
      {data.sources.length > 0 && (
        <div className='mb-3 space-y-1'>
          {data.sources.map((s, i) => (
            <div key={i} className='text-xs'>
              <a href={s.url} target='_blank' rel='noopener noreferrer' className='flex items-start gap-1 group transition-colors' style={{ color: 'var(--text-3)' }}>
                <span style={{ color: 'var(--text-4)' }}>↳</span>
                <span className='group-hover:underline leading-snug'>{(s.title || s.url).slice(0, 65)}</span>
              </a>
            </div>
          ))}
        </div>
      )}
      {data.done && (
        <div className='mt-2 pt-2 space-y-1.5' style={{ borderTop: '1px solid var(--border)' }}>
          <ClarityBar value={data.clarity} color={data.clarity >= 0.7 ? 'var(--green)' : data.clarity >= 0.4 ? 'var(--warn)' : 'var(--red)'} />
          <div className='flex gap-3 text-xs' style={{ color: 'var(--text-4)' }}>
            <span>+{data.created} beliefs</span>
            {data.contradictions > 0 && <span style={{ color: 'var(--warn)' }}>⚡ {data.contradictions} conflicts</span>}
          </div>
          {data.conflictPairs.length > 0 && (
            <div className='mt-2 space-y-1.5'>
              <p className='text-xs uppercase tracking-wider' style={{ color: 'var(--text-4)' }}>What conflicted</p>
              <div className='conflict-scroll max-h-48 overflow-y-auto space-y-1.5 pr-1'>
                {data.conflictPairs.map((pair, i) => !pair.a && !pair.b ? null : (
                  <div key={i} className='rounded px-2 py-1.5 space-y-1' style={{ border: '1px solid var(--warn-border)', background: 'var(--warn-bg)' }}>
                    {pair.a && <p className='text-xs leading-snug' style={{ color: 'var(--text-2)' }}>{pair.a.slice(0, 90)}{pair.a.length > 90 ? '…' : ''}</p>}
                    {pair.a && pair.b && <p className='text-xs' style={{ color: 'var(--text-4)' }}>↔ contradicts</p>}
                    {pair.b && <p className='text-xs leading-snug' style={{ color: 'var(--text-2)' }}>{pair.b.slice(0, 90)}{pair.b.length > 90 ? '…' : ''}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {data.queries.length === 0 && !data.done && <div className='text-xs italic' style={{ color: 'var(--text-4)' }}>Waiting…</div>}
    </div>
  );
}

function RoundCard({ round, maxRounds }: { round: RoundState; maxRounds: number }) {
  return (
    <div className='rounded-xl overflow-hidden' style={{ border: '1px solid var(--border)' }}>
      <div className='px-4 py-2 flex items-center justify-between' style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--border)' }}>
        <span className='text-sm font-bold' style={{ color: 'var(--text)' }}>
          Round {round.num} <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>/ {maxRounds}</span>
        </span>
        {round.done ? (
          <span className='text-xs flex items-center gap-2' style={{ color: 'var(--text-4)' }}>
            {round.contradictions > 0 && <Badge variant='amber'>⚡ {round.contradictions} conflicts</Badge>}
            <span>done</span>
          </span>
        ) : <Spinner />}
      </div>
      {round.reasoning && (
        <div className='px-4 py-2 space-y-1.5' style={{ background: 'color-mix(in srgb, var(--bg-2) 70%, transparent)', borderBottom: '1px solid color-mix(in srgb, var(--border) 50%, transparent)' }}>
          <p className='text-xs italic' style={{ color: 'var(--accent)' }}>
            <span style={{ color: 'color-mix(in srgb, var(--accent) 60%, transparent)', fontStyle: 'normal' }}>Director: </span>{round.reasoning}
          </p>
          {round.moveValue > 0 && (
            <div className='inline-flex items-center gap-1.5 text-xs'>
              <span style={{ color: 'var(--text-4)' }}>Next-round value</span>
              <span className='tabular-nums font-bold' style={{ color: round.moveValue >= 0.5 ? 'var(--green)' : round.moveValue >= 0.1 ? 'var(--warn)' : 'var(--red)' }}>{round.moveValue.toFixed(3)}</span>
            </div>
          )}
        </div>
      )}
      <div className='p-3 flex gap-3' style={{ background: 'var(--bg)' }}>
        <SideColumn side='pro' data={round.pro} label={round.proLabel} />
        <SideColumn side='anti' data={round.anti} label={round.antiLabel} />
      </div>
      {round.done && (
        <div className='px-4 py-2 flex flex-wrap items-center gap-4' style={{ background: 'color-mix(in srgb, var(--bg-2) 50%, transparent)', borderTop: '1px solid color-mix(in srgb, var(--border) 50%, transparent)' }}>
          <div className='flex items-center gap-2 text-xs' style={{ color: 'var(--text-4)' }}>
            <span style={{ color: 'var(--pro)' }}>{round.proLabel}</span>
            <ClarityBar value={round.proClarity} color={round.proClarity >= 0.7 ? 'var(--green)' : round.proClarity >= 0.4 ? 'var(--warn)' : 'var(--red)'} />
          </div>
          <div className='flex items-center gap-2 text-xs' style={{ color: 'var(--text-4)' }}>
            <span style={{ color: 'var(--anti)' }}>{round.antiLabel}</span>
            <ClarityBar value={round.antiClarity} color={round.antiClarity >= 0.7 ? 'var(--green)' : round.antiClarity >= 0.4 ? 'var(--warn)' : 'var(--red)'} />
          </div>
          {round.resolvedGaps.map((g, i) => <Badge key={i} variant='green'>✓ {g.replace('Unknown: ', '').slice(0, 42)}</Badge>)}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className='text-lg font-bold' style={{ color: color || 'var(--text)' }}>{value}</div>
      <div className='text-xs' style={{ color: 'var(--text-4)' }}>{label}</div>
    </div>
  );
}

function ScoreRow({ label, value }: { label: string; value: string }) {
  return (
    <><span style={{ color: 'var(--text-4)' }}>{label}</span><span className='tabular-nums' style={{ color: 'var(--text-2)' }}>{value}</span></>
  );
}

function JudgePanel({ judge, scorecard, totalSeedGaps }: { judge: JudgeState; scorecard: ScorecardState | null; totalSeedGaps: number }) {
  const resolvedGaps = Math.max(0, totalSeedGaps - judge.gaps.length);
  return (
    <div className='rounded-xl overflow-hidden' style={{ border: '1px solid var(--border)' }}>
      <div className='px-4 py-2' style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--border)' }}>
        <span className='text-sm font-bold' style={{ color: 'var(--text)' }}>Judge — fused namespace</span>
      </div>
      <div className='p-4 grid grid-cols-2 md:grid-cols-4 gap-4'>
        <Stat label='Total beliefs' value={String(judge.totalBeliefs)} />
        <Stat label='Established >0.70' value={String(judge.established)} color='var(--green)' />
        <Stat label='Contested 0.40–0.70' value={String(judge.contested)} color='var(--warn)' />
        <Stat label='Weak <0.40' value={String(judge.weak)} color='var(--red)' />
        <Stat label='Contradictions' value={String(judge.contradictionCount)} color={judge.contradictionCount > 10 ? 'var(--red)' : 'var(--warn)'} />
        <Stat label='Open gaps' value={String(judge.gaps.length)} />
        {totalSeedGaps > 0 && resolvedGaps > 0 && <Stat label='Gaps resolved' value={`${resolvedGaps} / ${totalSeedGaps}`} color='var(--green)' />}
      </div>
      {judge.gaps.length > 0 && (
        <div className='px-4 pb-4'>
          <p className='text-xs mb-2' style={{ color: 'var(--text-4)' }}>Unresolved gaps:</p>
          <div className='flex flex-wrap gap-1.5'>
            {judge.gaps.slice(0, 8).map((g, i) => <Badge key={i}>{g.replace(/^Unknown: /, '').slice(0, 50)}</Badge>)}
            {judge.gaps.length > 8 && <Badge>+{judge.gaps.length - 8} more</Badge>}
          </div>
        </div>
      )}
      {scorecard && (
        <>
          <div style={{ borderTop: '1px solid var(--border)' }} />
          <div className='px-4 py-3'>
            <p className='text-xs mb-3 uppercase tracking-wider' style={{ color: 'var(--text-4)' }}>Scorecard</p>
            <div className='grid grid-cols-2 gap-x-8 gap-y-1 text-xs'>
              <ScoreRow label='PRO created' value={String(scorecard.proCreated)} />
              <ScoreRow label='ANTI created' value={String(scorecard.antiCreated)} />
              <ScoreRow label='PRO clarity' value={scorecard.proClarity.toFixed(3)} />
              <ScoreRow label='ANTI clarity' value={scorecard.antiClarity.toFixed(3)} />
              <ScoreRow label='Contradictions' value={String(scorecard.contradictions)} />
              <ScoreRow label='Open gaps' value={String(scorecard.gaps)} />
              <ScoreRow label='Rounds run' value={String(scorecard.rounds)} />
              <ScoreRow label='Sources ingested' value={String(scorecard.sources)} />
              <ScoreRow label='Judge clarity' value={scorecard.judgeClarity.toFixed(3)} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
type ReportStyle = 'academic' | 'executive' | 'technical';

function ReportPanel({ snapshot }: { snapshot: BeliefSnapshot | null }) {
  const [style, setStyle] = useState<ReportStyle>('academic');
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const generate = useCallback(async (format: 'pdf' | 'docx') => {
    if (!snapshot) return;
    setGenerating(true);
    setError('');
    setProgress('Generating report with GPT-4o…');
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot, format, style }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Server error ${res.status}`);
      }
      const data = await res.json();
      setProgress(format === 'pdf' ? 'Building PDF…' : 'Building Word document…');
      if (format === 'pdf') {
        await generatePDF(data.markdown, snapshot.topic, snapshot.timestamp);
      } else {
        await generateDOCX(data.markdown, snapshot.topic, snapshot.timestamp);
      }
      setProgress('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }, [snapshot, style]);

  if (!snapshot) {
    return (
      <div className='rounded-xl p-4 text-center text-sm' style={{ border: '1px solid var(--border)', color: 'var(--text-4)', background: 'var(--bg-2)' }}>
        Complete a debate to generate reports
      </div>
    );
  }

  return (
    <div className='rounded-xl overflow-hidden' style={{ border: '1px solid var(--border)' }}>
      <div className='px-4 py-2 flex items-center justify-between' style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--border)' }}>
        <span className='text-sm font-bold' style={{ color: 'var(--text)' }}>Generate Research Report</span>
        <span className='text-xs' style={{ color: 'var(--text-4)' }}>{snapshot.sources} sources · {snapshot.totalBeliefs} beliefs</span>
      </div>
      <div className='p-4 space-y-4' style={{ background: 'var(--bg)' }}>
        <div>
          <p className='text-xs mb-2 uppercase tracking-wider' style={{ color: 'var(--text-4)' }}>Report style</p>
          <div className='flex gap-2'>
            {(['academic', 'executive', 'technical'] as ReportStyle[]).map((s) => (
              <button key={s} onClick={() => setStyle(s)} className='text-xs px-3 py-1.5 rounded capitalize transition-all'
                style={{ background: style === s ? 'var(--accent-bg)' : 'var(--bg-3)', color: style === s ? 'var(--accent)' : 'var(--text-3)', border: `1px solid ${style === s ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border)'}` }}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className='flex gap-3'>
          <button onClick={() => generate('pdf')} disabled={generating} className='flex-1 py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2'
            style={{ background: 'var(--accent-bg)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)', opacity: generating ? 0.6 : 1, cursor: generating ? 'not-allowed' : 'pointer' }}>
            {generating ? <Spinner /> : '⬇'} Download PDF
          </button>
          <button onClick={() => generate('docx')} disabled={generating} className='flex-1 py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2'
            style={{ background: 'var(--bg-3)', color: 'var(--text-2)', border: '1px solid var(--border)', opacity: generating ? 0.6 : 1, cursor: generating ? 'not-allowed' : 'pointer' }}>
            {generating ? <Spinner /> : '📄'} Download DOCX
          </button>
        </div>
        {progress && <div className='flex items-center gap-2 text-xs' style={{ color: 'var(--text-3)' }}><Spinner />{progress}</div>}
        {error && <p className='text-xs' style={{ color: 'var(--red)' }}>⚠ {error}</p>}
      </div>
    </div>
  );
}

async function generatePDF(markdown: string, topic: string, timestamp: number): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;
  const addPage = () => { doc.addPage(); y = margin; };
  const checkY = (needed: number) => { if (y + needed > pageHeight - margin) addPage(); };
  doc.setFillColor(9, 9, 11);
  doc.rect(0, 0, pageWidth, pageHeight, 'F');
  doc.setTextColor(244, 244, 245);
  doc.setFontSize(10);
  doc.text('BELIEF DEBATE ENGINE', margin, 30);
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  const titleLines = doc.splitTextToSize(topic.toUpperCase(), contentWidth);
  doc.text(titleLines, margin, 55);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(113, 113, 122);
  doc.text(new Date(timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), margin, pageHeight - 30);
  doc.addPage();
  y = margin;
  doc.setFillColor(250, 250, 250);
  doc.rect(0, 0, pageWidth, pageHeight, 'F');
  for (const line of markdown.split('\n')) {
    if (line.startsWith('# ')) {
      checkY(20); doc.setFontSize(18); doc.setFont('helvetica', 'bold'); doc.setTextColor(24, 24, 27);
      const w = doc.splitTextToSize(line.replace(/^# /, ''), contentWidth);
      doc.text(w, margin, y); y += w.length * 8 + 6;
    } else if (line.startsWith('## ')) {
      checkY(16); doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.setTextColor(39, 39, 42);
      const w = doc.splitTextToSize(line.replace(/^## /, ''), contentWidth);
      doc.text(w, margin, y); y += w.length * 6.5 + 4;
    } else if (line.startsWith('### ')) {
      checkY(12); doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(63, 63, 70);
      const w = doc.splitTextToSize(line.replace(/^### /, ''), contentWidth);
      doc.text(w, margin, y); y += w.length * 5.5 + 3;
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      checkY(8); doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(39, 39, 42);
      const w = doc.splitTextToSize('• ' + line.replace(/^[-*] /, '').replace(/\*\*(.*?)\*\*/g, '$1'), contentWidth - 4);
      doc.text(w, margin + 4, y); y += w.length * 5 + 2;
    } else if (line.trim() === '') {
      y += 3;
    } else {
      checkY(8); doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(39, 39, 42);
      const w = doc.splitTextToSize(line.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1'), contentWidth);
      doc.text(w, margin, y); y += w.length * 5 + 2;
    }
  }
  doc.save(`debate-report-${topic.slice(0, 30).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`);
}

async function generateDOCX(markdown: string, topic: string, timestamp: number): Promise<void> {
  const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Footer, PageNumber } = docx;
  const children: InstanceType<typeof Paragraph>[] = [];
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: topic, bold: true, size: 48 })], spacing: { after: 400 } }));
  children.push(new Paragraph({ children: [new TextRun({ text: `Belief Debate Engine Report — ${new Date(timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, color: '71717a', size: 20 })], spacing: { after: 600 } }));
  for (const line of markdown.split('\n')) {
    if (line.startsWith('# ')) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: line.replace(/^# /, ''), bold: true })], spacing: { before: 400, after: 200 } }));
    } else if (line.startsWith('## ')) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: line.replace(/^## /, ''), bold: true })], spacing: { before: 300, after: 160 } }));
    } else if (line.startsWith('### ')) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: line.replace(/^### /, ''), bold: true })], spacing: { before: 240, after: 120 } }));
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: line.replace(/^[-*] /, '').replace(/\*\*(.*?)\*\*/g, '$1') })], spacing: { before: 40, after: 40 } }));
    } else if (line.trim() === '') {
      children.push(new Paragraph({ children: [], spacing: { after: 120 } }));
    } else {
      children.push(new Paragraph({ children: [new TextRun({ text: line.replace(/\*\*(.*?)\*\*/g, '$1') })], spacing: { before: 40, after: 80 }, alignment: AlignmentType.JUSTIFIED }));
    }
  }
  const doc = new Document({
    creator: 'Belief Debate Engine',
    title: `Research Report: ${topic}`,
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          pageNumbers: { start: 1 },
        },
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '71717a' }), new TextRun({ text: ' · Belief Debate Engine', size: 18, color: '71717a' })],
          })],
        }),
      },
      children,
    }],
  });
  const buffer = await Packer.toBlob(doc);
  const url = URL.createObjectURL(buffer);
  const a = document.createElement('a');
  a.href = url; a.download = `debate-report-${topic.slice(0, 30).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.docx`;
  a.click(); URL.revokeObjectURL(url);
}

function BeliefSystemPanel({ system, onLoad, onDelete, onClear }: { system: EvolvedBeliefSystem; onLoad: (snap: BeliefSnapshot) => void; onDelete: (id: string) => void; onClear: () => void }) {
  const [expanded, setExpanded] = useState(false);
  if (system.totalDebates === 0) {
    return <div className='rounded-xl p-4 text-center' style={{ border: '1px solid var(--border)', background: 'var(--bg-2)' }}><p className='text-sm' style={{ color: 'var(--text-4)' }}>No saved debates yet.</p></div>;
  }
  return (
    <div className='rounded-xl overflow-hidden' style={{ border: '1px solid var(--border)' }}>
      <button className='w-full px-4 py-3 flex items-center justify-between' style={{ background: 'var(--bg-2)', borderBottom: expanded ? '1px solid var(--border)' : 'none' }} onClick={() => setExpanded(!expanded)}>
        <div className='flex items-center gap-3'>
          <span className='text-sm font-bold' style={{ color: 'var(--text)' }}>🧬 Evolving Belief System</span>
          <Badge variant='cyan'>{system.totalDebates} debates</Badge>
        </div>
        <span style={{ color: 'var(--text-4)' }}>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div style={{ background: 'var(--bg)' }}>
          <div className='px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-3' style={{ borderBottom: '1px solid var(--border)' }}>
            <Stat label='Total debates' value={String(system.totalDebates)} />
            <Stat label='Cumulative beliefs' value={system.cumulativeBeliefs.toLocaleString()} color='var(--green)' />
            <Stat label='Contradictions' value={system.cumulativeContradictions.toLocaleString()} color='var(--warn)' />
            <Stat label='Avg clarity' value={system.averageClarity.toFixed(3)} />
          </div>
          <div className='px-4 py-3 space-y-2'>
            <div className='flex items-center justify-between mb-3'>
              <p className='text-xs uppercase tracking-wider' style={{ color: 'var(--text-4)' }}>Saved debates</p>
              <button onClick={() => { if (confirm('Clear all?')) onClear(); }} className='text-xs px-2 py-1 rounded' style={{ color: 'var(--red)', border: '1px solid color-mix(in srgb, var(--red) 30%, transparent)', background: 'var(--anti-bg)' }}>Clear all</button>
            </div>
            {system.snapshots.map((snap) => (
              <div key={snap.id} className='rounded-lg p-3 flex items-start justify-between gap-3' style={{ background: 'var(--bg-2)', border: '1px solid var(--border)' }}>
                <div className='flex-1 min-w-0'>
                  <p className='text-sm font-medium truncate' style={{ color: 'var(--text)' }}>{snap.topic}</p>
                  <p className='text-xs mt-0.5' style={{ color: 'var(--text-4)' }}>{new Date(snap.timestamp).toLocaleDateString()} · {snap.totalBeliefs} beliefs · clarity {snap.judgeClarity.toFixed(2)}</p>
                </div>
                <div className='flex gap-1.5 shrink-0'>
                  <button onClick={() => onLoad(snap)} className='text-xs px-2 py-1 rounded' style={{ background: 'var(--accent-bg)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)' }}>Load</button>
                  <button onClick={() => onDelete(snap.id)} className='text-xs px-2 py-1 rounded' style={{ background: 'var(--anti-bg)', color: 'var(--anti)', border: '1px solid var(--anti-border)' }}>×</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [theme, setTheme] = useState<Theme>('dark');
  const [beliefSystem, setBeliefSystem] = useState<EvolvedBeliefSystem>(() => ({ topics: [], totalDebates: 0, cumulativeBeliefs: 0, cumulativeSources: 0, cumulativeContradictions: 0, averageClarity: 0, lastUpdated: 0, snapshots: [] }));
  const [currentSnapshot, setCurrentSnapshot] = useState<BeliefSnapshot | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle'|'saved'|'error'>('idle');
  const [showSidebar, setShowSidebar] = useState(false);
  const questionRef = useRef<HTMLInputElement>(null);
  const feedBottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { setBeliefSystem(loadBeliefSystem()); }, []);

  useEffect(() => {
    const vars = themes[theme];
    const root = document.documentElement;
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
    root.setAttribute('data-theme', theme);
    localStorage.setItem('debate_theme', theme);
  }, [theme]);

  useEffect(() => {
    const saved = localStorage.getItem('debate_theme') as Theme | null;
    if (saved && themes[saved]) setTheme(saved);
  }, []);

  useEffect(() => {
    feedBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [state.rounds.length, state.verdictText.length, state.judgeState]);

  useEffect(() => {
    if (state.phase !== 'done' || !state.scorecard || !state.config) return;
    const allSources: BeliefSnapshot['allSources'] = [];
    const allConflicts: BeliefSnapshot['allConflicts'] = [];
    const resolvedGaps: string[] = [];
    state.rounds.forEach((r) => {
      r.resolvedGaps.forEach((g) => resolvedGaps.push(g));
      (['pro', 'anti'] as const).forEach((side) => {
        r[side].sources.forEach((s) => allSources.push({ ...s, query: r[side].queries[0] || '' }));
        r[side].conflictPairs.forEach((c) => allConflicts.push(c));
      });
    });
    setCurrentSnapshot({
      id: generateSnapshotId(), topic: state.config.topic, timestamp: Date.now(),
      namespace: state.namespace,
      totalBeliefs: state.scorecard.proCreated + state.scorecard.antiCreated,
      established: state.judgeState?.established ?? 0,
      contested: state.judgeState?.contested ?? 0,
      weak: state.judgeState?.weak ?? 0,
      contradictions: state.scorecard.contradictions,
      gaps: state.judgeState?.gaps ?? [], resolvedGaps,
      rounds: state.scorecard.rounds, sources: state.scorecard.sources,
      judgeClarity: state.scorecard.judgeClarity,
      proClarity: state.scorecard.proClarity, antiClarity: state.scorecard.antiClarity,
      verdictText: state.verdictText, allSources, allConflicts,
    });
  }, [state.phase]);

  const saveCurrentDebate = useCallback(() => {
    if (!currentSnapshot) return;
    try { const updated = saveSnapshot(currentSnapshot); setBeliefSystem(updated); setSaveStatus('saved'); setTimeout(() => setSaveStatus('idle'), 2500); }
    catch { setSaveStatus('error'); }
  }, [currentSnapshot]);

  const runDebate = useCallback(async (question: string) => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    setCurrentSnapshot(null); setSaveStatus('idle');
    dispatch({ type: 'start_configuring' });
    try {
      const res = await fetch('/api/debate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }), signal: abortRef.current.signal });
      if (!res.ok || !res.body) { dispatch({ type: 'error', message: `Server error ${res.status}` }); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try { dispatch(JSON.parse(line.slice(6)) as DebateEvent); } catch { /* skip */ }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      dispatch({ type: 'error', message: String(err) });
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = questionRef.current?.value.trim();
    if (!q || state.phase !== 'idle') return;
    runDebate(q);
  };

  const handleReset = () => { abortRef.current?.abort(); dispatch({ type: 'reset' }); setTimeout(() => questionRef.current?.focus(), 50); };
  const isRunning = state.phase !== 'idle' && state.phase !== 'done' && state.phase !== 'error';
  const themeOrder: Theme[] = ['dark', 'light', 'sepia'];
  const themeIcons: Record<Theme, string> = { dark: '🌙', light: '☀️', sepia: '📜' };
  const nextTheme = themeOrder[(themeOrder.indexOf(theme) + 1) % themeOrder.length];

  return (
    <div className='min-h-screen flex flex-col font-mono' style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <header className='sticky top-0 z-20 backdrop-blur px-4 py-3 flex items-center justify-between' style={{ background: 'color-mix(in srgb, var(--bg) 90%, transparent)', borderBottom: '1px solid var(--border)' }}>
        <div className='flex items-center gap-3'>
          <span className='text-sm font-bold' style={{ color: 'var(--text-2)' }}>🧠 Belief Debate Engine</span>
          {state.config && <span className='text-xs max-w-xs truncate hidden sm:block' style={{ color: 'var(--text-4)' }}>{state.config.topic}</span>}
        </div>
        <div className='flex items-center gap-2'>
          {state.rounds.length > 0 && <span className='text-xs mr-1' style={{ color: 'var(--text-4)' }}>Round {state.rounds.length} / {state.maxRounds}</span>}
          <button onClick={() => setShowSidebar(!showSidebar)} className='text-xs px-2 py-1 rounded transition-all' style={{ background: showSidebar ? 'var(--bg-3)' : 'transparent', color: 'var(--text-3)', border: '1px solid var(--border)' }}>
            🧬 {beliefSystem.totalDebates > 0 && `(${beliefSystem.totalDebates})`}
          </button>
          {currentSnapshot && state.phase === 'done' && (
            <button onClick={saveCurrentDebate} className='text-xs px-2.5 py-1 rounded transition-all' style={{ background: saveStatus === 'saved' ? 'var(--pro-bg)' : 'var(--accent-bg)', color: saveStatus === 'saved' ? 'var(--green)' : 'var(--accent)', border: `1px solid ${saveStatus === 'saved' ? 'var(--pro-border)' : 'color-mix(in srgb, var(--accent) 30%, transparent)'}` }}>
              {saveStatus === 'saved' ? '✓ Saved' : '💾 Save debate'}
            </button>
          )}
          <button onClick={() => setTheme(nextTheme)} title={`Switch to ${nextTheme} theme`} className='text-xs px-2 py-1 rounded transition-all' style={{ color: 'var(--text-3)', border: '1px solid var(--border)' }}>
            {themeIcons[theme]}
          </button>
          {state.phase !== 'idle' && <button onClick={handleReset} className='text-xs px-2 py-1 rounded transition-all' style={{ color: 'var(--text-4)', border: '1px solid var(--border)' }}>Reset</button>}
        </div>
      </header>

      <div className='flex flex-1'>
        <main className='flex-1 max-w-4xl mx-auto w-full px-4 py-8 space-y-6'>
          {state.phase === 'idle' && (
            <div className='flex flex-col items-center justify-center min-h-[60vh] gap-8'>
              <div className='text-center space-y-2'>
                <h1 className='text-2xl font-bold' style={{ color: 'var(--text)' }}>Epistemic Debate Engine</h1>
                <p className='text-sm' style={{ color: 'var(--text-4)' }}>Two AI agents research opposing sides using live web evidence.<br /><span>Powered by thinkn.ai · Exa · GPT-4o</span></p>
              </div>
              <form onSubmit={handleSubmit} className='w-full max-w-xl space-y-3'>
                <input ref={questionRef} type='text' defaultValue='Are EVs good or bad for the planet?' placeholder='Enter any debatable question…' className='w-full rounded-lg px-4 py-3 text-sm transition' style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--text)', outline: 'none' }} autoFocus />
                <button type='submit' className='w-full rounded-lg py-3 text-sm font-medium transition-all' style={{ background: 'var(--bg-3)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>Run Debate →</button>
              </form>
              {beliefSystem.totalDebates > 0 && (
                <div className='w-full max-w-xl rounded-xl p-4 text-center' style={{ background: 'var(--bg-2)', border: '1px solid var(--border)' }}>
                  <p className='text-sm' style={{ color: 'var(--text-3)' }}>🧬 {beliefSystem.totalDebates} saved debates · {beliefSystem.cumulativeBeliefs.toLocaleString()} total beliefs</p>
                  <button onClick={() => setShowSidebar(true)} className='text-xs mt-2 underline' style={{ color: 'var(--accent)' }}>View knowledge base →</button>
                </div>
              )}
              <div className='text-xs text-center max-w-sm' style={{ color: 'var(--text-4)' }}>Debates typically run 4–8 minutes and cite 50–80 real sources.</div>
            </div>
          )}
          {state.phase === 'configuring' && !state.config && (
            <div className='flex items-center gap-3 p-4 rounded-xl' style={{ border: '1px solid var(--border)', background: 'var(--bg-2)' }}>
              <Spinner />
              <div><p className='text-sm' style={{ color: 'var(--text)' }}>GPT-4o is designing the debate…</p><p className='text-xs' style={{ color: 'var(--text-4)' }}>Generating sides, gaps, and seed queries</p></div>
            </div>
          )}
          {state.config && (
            <div className='rounded-xl p-4 space-y-3' style={{ border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--bg-2) 60%, transparent)' }}>
              <div className='flex flex-wrap items-center gap-2'>
                <Badge variant='green'>{state.config.sides.pro.label}</Badge>
                <span className='text-xs' style={{ color: 'var(--text-4)' }}>vs</span>
                <Badge variant='red'>{state.config.sides.anti.label}</Badge>
                {state.namespace && <span className='text-xs ml-auto font-mono' style={{ color: 'var(--text-4)' }}>{state.namespace}</span>}
              </div>
              <p className='text-xs italic' style={{ color: 'var(--text-3)' }}>{state.goal}</p>
              <div className='flex flex-wrap gap-1.5'>
                {state.gaps.map((g, i) => <Badge key={i}>{g.replace(/^Unknown: /, '').slice(0, 55)}</Badge>)}
              </div>
            </div>
          )}
          {state.earlyExit && (
            <div className='rounded-lg px-4 py-2.5 text-xs' style={{ border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)', background: 'var(--accent-bg)', color: 'var(--accent)' }}>
              ⊘ {state.earlyExit}
            </div>
          )}
          {state.rounds.map((round) => <RoundCard key={round.num} round={round} maxRounds={state.maxRounds} />)}
          {isRunning && state.phase === 'running' && (
            <div className='flex items-center gap-2 text-xs py-2' style={{ color: 'var(--text-4)' }}><Spinner /><span>Researching…</span></div>
          )}
          {state.judgeState && <JudgePanel judge={state.judgeState} scorecard={state.scorecard} totalSeedGaps={state.gaps.length} />}
          {(state.verdictText || state.phase === 'judging') && (
            <div className='rounded-xl overflow-hidden' style={{ border: '1px solid var(--border)' }}>
              <div className='px-4 py-2 flex items-center justify-between' style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--border)' }}>
                <span className='text-sm font-bold' style={{ color: 'var(--text)' }}>GPT-4o Verdict</span>
                {!state.verdictDone && <Spinner />}
              </div>
              <div className={`p-5 text-sm leading-relaxed ${!state.verdictDone ? 'cursor-blink' : ''}`} style={{ color: 'var(--text-2)', background: 'var(--bg)' }}>
                {state.verdictText ? (
                  <ReactMarkdown components={{
                    h1: ({ children }) => <h1 className='text-base font-bold mt-4 mb-2 first:mt-0' style={{ color: 'var(--text)' }}>{children}</h1>,
                    h2: ({ children }) => <h2 className='text-sm font-bold mt-4 mb-2' style={{ color: 'var(--text)' }}>{children}</h2>,
                    h3: ({ children }) => <h3 className='text-xs font-bold uppercase tracking-wider mt-4 mb-1.5' style={{ color: 'var(--text-2)' }}>{children}</h3>,
                    p: ({ children }) => <p className='mb-3 last:mb-0 leading-relaxed'>{children}</p>,
                    strong: ({ children }) => <strong className='font-semibold' style={{ color: 'var(--text)' }}>{children}</strong>,
                    ul: ({ children }) => <ul className='list-disc list-inside space-y-1 mb-3' style={{ color: 'var(--text-3)' }}>{children}</ul>,
                    ol: ({ children }) => <ol className='list-decimal list-inside space-y-1 mb-3' style={{ color: 'var(--text-3)' }}>{children}</ol>,
                    li: ({ children }) => <li style={{ color: 'var(--text-2)' }}>{children}</li>,
                    hr: () => <hr style={{ borderColor: 'var(--border)', margin: '1rem 0' }} />,
                    code: ({ children }) => <code className='px-1 rounded text-xs' style={{ background: 'var(--bg-3)', color: 'var(--warn)' }}>{children}</code>,
                  }}>{state.verdictText}</ReactMarkdown>
                ) : <span className='italic' style={{ color: 'var(--text-4)' }}>Synthesising evidence…</span>}
              </div>
            </div>
          )}
          {state.phase === 'done' && currentSnapshot && <ReportPanel snapshot={currentSnapshot} />}
          {state.phase === 'done' && (
            <div className='flex flex-col items-center gap-4 py-8'>
              <div className='flex items-center gap-3'>
                {saveStatus !== 'saved' && <button onClick={saveCurrentDebate} className='text-sm px-4 py-2 rounded-lg transition-all' style={{ background: 'var(--accent-bg)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)' }}>💾 Save to knowledge base</button>}
                <button onClick={handleReset} className='text-sm px-4 py-2 rounded-lg transition-all' style={{ color: 'var(--text-3)', border: '1px solid var(--border)' }}>Run another debate →</button>
              </div>
              <p className='text-xs' style={{ color: 'var(--text-4)' }}>Debate complete.</p>
            </div>
          )}
          {state.phase === 'error' && (
            <div className='rounded-lg p-4 space-y-2' style={{ border: '1px solid var(--anti-border)', background: 'var(--anti-bg)' }}>
              <p className='text-sm font-bold' style={{ color: 'var(--anti)' }}>Error</p>
              <p className='text-xs' style={{ color: 'var(--anti)' }}>{state.error}</p>
              <button onClick={handleReset} className='text-xs underline mt-1' style={{ color: 'var(--text-3)' }}>Reset</button>
            </div>
          )}
          <div ref={feedBottomRef} />
        </main>

        {showSidebar && (
          <aside className='w-96 shrink-0 border-l overflow-y-auto' style={{ borderColor: 'var(--border)', background: 'var(--bg-2)', position: 'sticky', top: '57px', height: 'calc(100vh - 57px)' }}>
            <div className='p-4 space-y-4'>
              <div className='flex items-center justify-between'>
                <h2 className='text-sm font-bold' style={{ color: 'var(--text)' }}>🧬 Knowledge Base</h2>
                <button onClick={() => setShowSidebar(false)} className='text-xs px-2 py-1 rounded' style={{ color: 'var(--text-4)', border: '1px solid var(--border)' }}>×</button>
              </div>
              <BeliefSystemPanel system={beliefSystem} onLoad={(snap) => { setCurrentSnapshot(snap); setShowSidebar(false); }} onDelete={(id) => setBeliefSystem(deleteSnapshot(id))} onClear={() => { clearAllSnapshots(); setBeliefSystem(loadBeliefSystem()); }} />
              {currentSnapshot && (
                <div className='pt-2' style={{ borderTop: '1px solid var(--border)' }}>
                  <p className='text-xs mb-3 uppercase tracking-wider' style={{ color: 'var(--text-4)' }}>Generate report</p>
                  <ReportPanel snapshot={currentSnapshot} />
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
