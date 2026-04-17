/**
 * debate-runner.ts — UI-optimised debate engine (patched)
 *
 * Key fixes from thinkn.ai hack guide audit:
 *   1. PRO/ANTI agents now call before() before each round to get belief context
 *   2. Exa raw text is synthesized through GPT-4o BEFORE being fed to after()
 *      This filters boilerplate and grounds new research in existing beliefs
 *   3. debateDirector() now injects judge.before() prompt into its system context
 *   4. BeliefsError rate-limit handling with exponential backoff
 */

import { Exa } from 'exa-js';
import Beliefs, { type BeliefDelta } from 'beliefs';
import OpenAI from 'openai';
import type { DebateEvent, DebateConfig, SideConfig } from '@/src/types/debate';

export type { DebateEvent, DebateConfig, SideConfig };

export interface DirectorPlan {
  pro: { angle: string; query1: string; query2: string; moveAction?: string };
  anti: { angle: string; query1: string; query2: string; moveAction?: string };
  reasoning: string;
  moveValue?: number;
  suggestStop: boolean;
}

export interface DebateDeps {
  apiKey: string;
  exa: Exa;
  openai: OpenAI;
  onEvent: (e: DebateEvent) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit safe wrapper
// ─────────────────────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const e = err as { retryable?: boolean; retryAfterMs?: number; message?: string };
      const isRateLimit =
        e?.retryable === true ||
        (typeof e?.message === 'string' && e.message.includes('rate_limit'));
      if (isRateLimit && attempt < maxAttempts - 1) {
        const wait = e?.retryAfterMs ?? (1000 * 2 ** attempt);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error('withRetry exhausted');
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

export async function generateDebateConfig(
  question: string,
  openai: OpenAI,
): Promise<DebateConfig> {
  const systemPrompt =
    `You are an expert debate architect. Given a debate question, design a complete ` +
    `configuration for a two-sided epistemic debate to be researched via live web sources.\n\n` +
    `Your job:\n` +
    `1. Choose short, URL-friendly slugs for pro and anti agent names (e.g. "pro-replacement", ` +
    `"anti-replacement") — lowercase, hyphens only, no spaces.\n` +
    `2. Choose concise display labels (e.g. "PRO", "ANTI" or more descriptive like "PRO-AI", "ANTI-AI").\n` +
    `3. Write a clear, empirically-framed goal statement (one sentence, starts with "Determine whether...").\n` +
    `4. Identify exactly 4 specific, empirically-investigable gaps — things genuinely unknown/contested ` +
    `that can be resolved via web search. Each must start with "Unknown: ".\n` +
    `5. Write exactly 2 rounds of seed queries that bootstrap the debate:\n` +
    `   - Round 1: establish the core tension (most fundamental opposing claims on each side).\n` +
    `   - Round 2: go one layer deeper (evidence quality, timeline, scale, or second-order effects).\n\n` +
    `Rules:\n` +
    `- Gaps must start with "Unknown: " and be specific enough to be resolvable via web search.\n` +
    `- Queries must be specific, cite-worthy search terms (think peer-reviewed paper titles or reputable headlines).\n` +
    `- Each round's pro and anti angles must create genuine epistemic tension.\n` +
    `- Output ONLY valid JSON — no markdown, no explanation outside the JSON.\n\n` +
    `JSON shape (strict):\n` +
    `{\n` +
    `  "proName": "...",\n` +
    `  "proLabel": "...",\n` +
    `  "antiName": "...",\n` +
    `  "antiLabel": "...",\n` +
    `  "seedGoal": "Determine whether ...",\n` +
    `  "seedGaps": ["Unknown: ...", "Unknown: ...", "Unknown: ...", "Unknown: ..."],\n` +
    `  "seedPlans": [\n` +
    `    {\n` +
    `      "pro":  { "angle": "...", "query1": "...", "query2": "..." },\n` +
    `      "anti": { "angle": "...", "query1": "...", "query2": "..." },\n` +
    `      "reasoning": "<one sentence describing what this round establishes>",\n` +
    `      "suggestStop": false\n` +
    `    },\n` +
    `    {\n` +
    `      "pro":  { "angle": "...", "query1": "...", "query2": "..." },\n` +
    `      "anti": { "angle": "...", "query1": "...", "query2": "..." },\n` +
    `      "reasoning": "<one sentence describing what this round deepens>",\n` +
    `      "suggestStop": false\n` +
    `    }\n` +
    `  ]\n` +
    `}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.6,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Design a debate configuration for: "${question}"`,
      },
    ],
  });

  const raw = completion.choices[0].message.content ?? '{}';

  try {
    const parsed = JSON.parse(raw) as {
      proName?: string;
      proLabel?: string;
      antiName?: string;
      antiLabel?: string;
      seedGoal?: string;
      seedGaps?: string[];
      seedPlans?: DirectorPlan[];
    };
    return {
      topic: question,
      sides: {
        pro: {
          name: parsed.proName ?? 'pro-side',
          label: parsed.proLabel ?? 'PRO',
        },
        anti: {
          name: parsed.antiName ?? 'anti-side',
          label: parsed.antiLabel ?? 'ANTI',
        },
      },
      seedGoal: parsed.seedGoal ?? `Investigate the truth of: ${question}`,
      seedGaps: parsed.seedGaps ?? [
        'Unknown: current state of expert evidence on this topic',
        'Unknown: key empirical measures and data quality',
        'Unknown: historical precedents relevant to this question',
        'Unknown: quantitative projections and uncertainty ranges',
      ],
      ...(parsed.seedPlans ? { seedPlans: parsed.seedPlans } : {}),
    } as DebateConfig & { seedPlans?: DirectorPlan[] };
  } catch {
    const slug = question
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 20)
      .replace(/-+$/, '');
    const t = question.slice(0, 55);
    return {
      topic: question,
      sides: {
        pro: { name: `pro-${slug}`, label: 'PRO' },
        anti: { name: `anti-${slug}`, label: 'ANTI' },
      },
      seedGoal: `Investigate the truth of: ${question}`,
      seedGaps: [
        'Unknown: current state of expert evidence on this topic',
        'Unknown: key empirical measures and data quality',
        'Unknown: historical precedents relevant to this question',
        'Unknown: quantitative projections and uncertainty ranges',
      ],
      seedPlans: [
        {
          pro: {
            angle: `Supporting: ${t}`,
            query1: `evidence supporting ${t} study 2024 2025`,
            query2: `research confirming ${t} peer review`,
          },
          anti: {
            angle: `Opposing: ${t}`,
            query1: `evidence against ${t} criticism 2024 2025`,
            query2: `counterargument problems ${t} analysis`,
          },
          reasoning: 'Fallback round 1 — broad evidence gathering.',
          suggestStop: false,
        },
        {
          pro: {
            angle: `Expert consensus for: ${t}`,
            query1: `expert consensus ${t} academic study`,
            query2: `quantitative data supporting ${t}`,
          },
          anti: {
            angle: `Expert dissent: ${t}`,
            query1: `expert criticism risks ${t} problems`,
            query2: `systematic review counterevidence ${t}`,
          },
          reasoning: 'Fallback round 2 — deeper expert perspectives.',
          suggestStop: false,
        },
      ],
    } as DebateConfig & { seedPlans?: DirectorPlan[] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main debate runner
// ─────────────────────────────────────────────────────────────────────────────

export async function runDebate(
  config: DebateConfig & { seedPlans?: DirectorPlan[] },
  deps: DebateDeps,
): Promise<void> {
  const { apiKey, exa, openai, onEvent } = deps;
  const MAX_ROUNDS = config.maxRounds ?? 6;
  const CONTRADICTION_THRESHOLD = 2;
  const REANCHOR_INTERVAL = 2;

  // ── Namespace + agents ───────────────────────────────────────────────────────
  const slug = config.topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 30)
    .replace(/-+$/, '');
  const ns = `${slug}-${Date.now()}`;

  const makeAgent = (agentName: string) =>
    new Beliefs({
      apiKey,
      agent: agentName,
      namespace: ns,
      writeScope: 'space',
      baseUrl: 'https://www.thinkn.ai',
    });

  const proAgent  = makeAgent(config.sides.pro.name);
  const antiAgent = makeAgent(config.sides.anti.name);
  const judge     = makeAgent('judge');

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function pickSearchType(moveAction: string): 'fast' | 'auto' | 'deep' {
    if (moveAction === 'clarify') return 'fast';
    if (moveAction === 'resolve_uncertainty' || moveAction === 'compare_paths') return 'deep';
    return 'auto';
  }

  const seenUrls = new Set<string>();

  /**
   * PATCHED searchAndFeed:
   * 1. Fetches Exa results as before
   * 2. Calls agent.before() to get current belief context — FIX #1
   * 3. Runs GPT-4o to synthesize web content IN LIGHT OF existing beliefs — FIX #2
   *    (filters boilerplate, avoids re-stating established claims, extracts new signal)
   * 4. Feeds the GPT-4o synthesis to agent.after() — cleaner input = better extraction
   */
  async function searchAndFeed(
    agent: Beliefs,
    queries: string[],
    source: string,
    moveAction = 'gather_evidence',
    sideLabel: string,
  ): Promise<{
    delta: BeliefDelta;
    sources: Array<{ title: string | null; url: string }>;
  }> {
    const searchType = pickSearchType(moveAction);

    // Fetch web content
    const results = await Promise.all(
      queries.map(q =>
        exa.searchAndContents(q, {
          numResults: 3,
          type: searchType,
          text: { maxCharacters: 15000 },
        }),
      ),
    );

    const parts: string[] = [];
    const sources: Array<{ title: string | null; url: string }> = [];
    for (const res of results) {
      for (const r of res.results) {
        if (seenUrls.has(r.url)) continue;
        seenUrls.add(r.url);
        sources.push({ title: r.title, url: r.url });
        const content = (r as { text?: string }).text ?? '';
        if (content.length >= 200)
          parts.push(`[Source: ${r.title ?? r.url}]\n${content.slice(0, 14000)}`);
      }
    }

    if (parts.length === 0) {
      const world = await withRetry(() => agent.read());
      const noOpDelta: BeliefDelta = {
        clarity: world.clarity,
        readiness: world.clarity >= 0.7 ? 'high' : world.clarity >= 0.4 ? 'medium' : 'low',
        changes: [],
        moves: world.moves ?? [],
        state: {
          beliefs: world.beliefs,
          contradictions: world.contradictions,
          gaps: world.gaps,
        } as BeliefDelta['state'],
      };
      return { delta: noOpDelta, sources: [] };
    }

    const rawWebText = parts.join('\n\n');

    // FIX #1: Call before() to get current belief context
    const beliefContext = await withRetry(() => agent.before());

    // FIX #2: Synthesize web content through GPT-4o using belief context as system prompt
    // This: (a) filters HTML boilerplate/nav noise, (b) avoids restating established beliefs,
    // (c) focuses extraction on genuinely new claims, (d) tags source evidence properly
    let synthesizedText: string;
    try {
      const synthesis = await openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.2,
        max_tokens: 2000,
        messages: [
          {
            role: 'system',
            content:
              beliefContext.prompt +
              `\n\n---\nYou are the ${sideLabel} research agent in an epistemic debate on: "${config.topic}".\n` +
              `Your task: Extract the key factual claims, statistics, and evidence from the web sources below.\n` +
              `Rules:\n` +
              `- State each claim clearly and specifically with any numbers, dates, or citations present.\n` +
              `- Do NOT repeat claims already established in your belief state above.\n` +
              `- Focus on NEW information that adds to, contradicts, or qualifies existing beliefs.\n` +
              `- If a source contradicts an existing belief, state both positions explicitly.\n` +
              `- Write 10-20 factual statements. No opinions, no summaries of your role.`,
          },
          {
            role: 'user',
            content: rawWebText.slice(0, 60000),
          },
        ],
      });
      synthesizedText = synthesis.choices[0]?.message?.content ?? rawWebText.slice(0, 8000);
    } catch {
      // If synthesis fails (e.g. rate limit on OpenAI), fall back to raw text
      synthesizedText = rawWebText.slice(0, 8000);
    }

    // Feed synthesized text — much cleaner signal for the beliefs SDK
    const delta = await withRetry(() => agent.after(synthesizedText, { source }));

    if (delta.clarity === 0 && delta.changes.length === 0) {
      const world = await withRetry(() => agent.read());
      const noOpDelta: BeliefDelta = {
        clarity: world.clarity,
        readiness: world.clarity >= 0.7 ? 'high' : world.clarity >= 0.4 ? 'medium' : 'low',
        changes: [],
        moves: world.moves ?? [],
        state: {
          beliefs: world.beliefs,
          contradictions: world.contradictions,
          gaps: world.gaps,
        } as BeliefDelta['state'],
      };
      return { delta: noOpDelta, sources };
    }

    return { delta, sources };
  }

  /**
   * PATCHED debateDirector:
   * FIX #3: Now injects judge.before() prompt into GPT-4o system context
   * so the director's query generation is grounded in the actual belief graph state
   */
  async function debateDirector(
    world: Awaited<ReturnType<typeof judge.read>>,
    roundNum: number,
  ): Promise<DirectorPlan> {
    const agentMoves = (world.moves ?? [])
      .filter(m => m.executor !== 'user')
      .slice(0, 4);
    const proMove  = agentMoves[0];
    const antiMove = agentMoves[1] ?? agentMoves[0];
    const proTarget  = proMove?.target  ?? world.gaps[0] ?? config.topic;
    const antiTarget = antiMove?.target ?? world.gaps[1] ?? world.gaps[0] ?? config.topic;
    const topValue   = proMove?.value ?? 0;

    const shouldStop =
      world.moves.length === 0 ||
      topValue < 0.1 ||
      (world.gaps.length === 0 && world.contradictions.length >= CONTRADICTION_THRESHOLD);

    // FIX #3: get judge's current belief brief
    const judgeContext = await withRetry(() => judge.before());

    const systemPrompt =
      judgeContext.prompt +  // inject structured belief graph as system context
      `\n\n---\nYou are a search query generator for an epistemic debate on: "${config.topic}"\n\n` +
      `Your ONLY job: translate two investigation targets into specific Exa web-search queries.\n` +
      `Rules:\n` +
      `1. Each target gets 2 queries covering DIFFERENT facets — do not duplicate.\n` +
      `2. Queries must be specific and cite-worthy (think paper titles or news headlines).\n` +
      `3. Avoid querying topics already well-established in the belief graph above.\n` +
      `4. Output ONLY valid JSON.\n\n` +
      `JSON shape:\n` +
      `{ "pro": { "angle": "...", "query1": "...", "query2": "..." }, "anti": { "angle": "...", "query1": "...", "query2": "..." }, "reasoning": "one sentence" }`;

    const userMsg =
      `PRO — "${proTarget}" (value=${topValue.toFixed(2)}, action=${proMove?.action ?? 'gather_evidence'})\n` +
      `ANTI — "${antiTarget}" (value=${(antiMove?.value ?? topValue).toFixed(2)})\n` +
      `State: ${world.beliefs.length} beliefs · ${world.gaps.length} gaps · ${world.contradictions.length} contradictions · round ${roundNum}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
    });

    const raw = completion.choices[0].message.content ?? '{}';
    try {
      const parsed = JSON.parse(raw) as Omit<DirectorPlan, 'suggestStop' | 'moveValue'>;
      return {
        pro:  { ...parsed.pro,  moveAction: proMove?.action  ?? 'gather_evidence' },
        anti: { ...parsed.anti, moveAction: antiMove?.action ?? 'gather_evidence' },
        reasoning: parsed.reasoning,
        moveValue: topValue,
        suggestStop: shouldStop,
      };
    } catch {
      return {
        pro: {
          angle: proTarget.slice(0, 80),
          query1: `${proTarget.replace('Unknown: ', '')} evidence 2024 2025`,
          query2: `${proTarget.replace('Unknown: ', '')} research study`,
          moveAction: proMove?.action ?? 'gather_evidence',
        },
        anti: {
          angle: antiTarget.slice(0, 80),
          query1: `${antiTarget.replace('Unknown: ', '')} counterevidence`,
          query2: `${antiTarget.replace('Unknown: ', '')} risks limitations`,
          moveAction: antiMove?.action ?? 'gather_evidence',
        },
        reasoning: `Fallback plan — value=${topValue.toFixed(2)}`,
        moveValue: topValue,
        suggestStop: shouldStop,
      };
    }
  }

  // ── Seed shared goal + gaps ──────────────────────────────────────────────────
  await withRetry(() =>
    proAgent.add([
      { text: config.seedGoal, type: 'goal' },
      ...config.seedGaps.map(text => ({ text, type: 'gap' as const })),
    ])
  );

  onEvent({
    type: 'seed_done',
    goal: config.seedGoal,
    gaps: config.seedGaps,
    namespace: ns,
  });
  console.log(`[debate] seed_done namespace=${ns} gaps=${config.seedGaps.length}`);
  await new Promise(r => setTimeout(r, 400));

  // ── Score + gap tracking ─────────────────────────────────────────────────────
  const score = {
    pro:  { created: 0, clarityLast: 0 },
    anti: { created: 0, clarityLast: 0 },
  };
  const seedPlans: DirectorPlan[] = config.seedPlans ?? [];
  let roundsSinceReanchor = 0;
  const resolvedSeedGaps = new Set<string>();
  let reanchorIndex = 0;

  const seenContradictions = new Set<string>();
  const globalBeliefMap    = new Map<string, string>();

  function pickReanchorTarget(): string | null {
    const unresolved = config.seedGaps.filter(g => !resolvedSeedGaps.has(g));
    if (unresolved.length === 0) return null;
    const target = unresolved[reanchorIndex % unresolved.length];
    reanchorIndex++;
    return target;
  }

  async function resolveClosedGaps(
    worldGaps: string[],
    moveTargets: string[] = [],
  ): Promise<void> {
    for (const target of moveTargets) {
      if (resolvedSeedGaps.has(target) || target.length < 5) continue;
      const stillOpen = worldGaps.some(
        wg => wg === target || wg.includes(target.replace('Unknown: ', '')),
      );
      if (!stillOpen) {
        resolvedSeedGaps.add(target);
        await withRetry(() => judge.resolve(target)).catch(() => {});
        onEvent({ type: 'gap_resolved', gap: target, how: 'move' });
      }
    }
    for (const seedGap of config.seedGaps) {
      if (resolvedSeedGaps.has(seedGap)) continue;
      const keywords = seedGap
        .replace('Unknown: ', '')
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 4)
        .slice(0, 3);
      const stillOpen = worldGaps.some(
        wg => keywords.filter(kw => wg.toLowerCase().includes(kw)).length >= 2,
      );
      if (!stillOpen) {
        resolvedSeedGaps.add(seedGap);
        await withRetry(() => judge.resolve(seedGap)).catch(() => {});
        onEvent({ type: 'gap_resolved', gap: seedGap, how: 'seed' });
      }
    }
  }

  // ── Debate loop ──────────────────────────────────────────────────────────────
  let lastProDelta:  BeliefDelta | null = null;
  let lastAntiDelta: BeliefDelta | null = null;
  let earlyExit   = false;
  let roundNum    = 0;
  const clarityHistory: number[] = [];
  let previousContradictionCount = 0;

  while (roundNum < MAX_ROUNDS && !earlyExit) {
    roundNum++;
    let plan: DirectorPlan;
    let moveTargetsThisRound: string[] = [];

    if (roundNum <= seedPlans.length) {
      plan = seedPlans[roundNum - 1];
    } else {
      const interimWorld = await withRetry(() => judge.read());
      moveTargetsThisRound = (interimWorld.moves ?? [])
        .filter(m => m.executor !== 'user')
        .slice(0, 2)
        .map(m => m.target);

      const reanchorTarget  = pickReanchorTarget();
      const shouldReanchor  =
        roundsSinceReanchor >= REANCHOR_INTERVAL && reanchorTarget !== null;

      if (shouldReanchor) {
        const topMove = (interimWorld.moves ?? []).find(m => m.executor !== 'user');
        const patchedWorld = {
          ...interimWorld,
          moves: [
            {
              target: reanchorTarget!,
              value: 1.0,
              action: topMove?.action ?? 'gather_evidence',
              executor: 'agent' as const,
              reason: 'Reanchor',
            },
            ...(interimWorld.moves ?? []).slice(1),
          ],
        };
        roundsSinceReanchor = 0;
        plan = await debateDirector(patchedWorld, roundNum);
      } else {
        plan = await debateDirector(interimWorld, roundNum);
        roundsSinceReanchor++;
      }
    }

    onEvent({
      type: 'round_start',
      round: roundNum,
      maxRounds: MAX_ROUNDS,
      reasoning: plan.reasoning,
      moveValue: plan.moveValue ?? 0,
      proAngle: plan.pro.angle,
      antiAngle: plan.anti.angle,
      proLabel: config.sides.pro.label,
      antiLabel: config.sides.anti.label,
    });
    console.log(
      `[debate] round_start round=${roundNum} moveValue=${(plan.moveValue ?? 0).toFixed(3)}`,
    );

    let roundNewConflictCount = 0;

    for (const side of ['pro', 'anti'] as const) {
      const cfg       = plan[side];
      const agent     = side === 'pro' ? proAgent : antiAgent;
      const sideLabel =
        side === 'pro' ? config.sides.pro.label : config.sides.anti.label;

      onEvent({
        type: 'side_queries',
        side,
        label: sideLabel,
        queries: [cfg.query1, cfg.query2],
      });

      // PATCHED: pass sideLabel so searchAndFeed can reference it in the GPT-4o prompt
      const { delta, sources } = await searchAndFeed(
        agent,
        [cfg.query1, cfg.query2],
        side,
        cfg.moveAction ?? 'gather_evidence',
        sideLabel,
      );

      onEvent({ type: 'side_sources', side, sources });

      const created = delta.changes.filter(c => c.action === 'created').length;
      score[side].created    += created;
      score[side].clarityLast = delta.clarity;

      // Update global belief map for conflict resolution
      for (const b of delta.state.beliefs as unknown as Array<Record<string, unknown>>) {
        if (typeof b.id === 'string' && typeof b.text === 'string')
          globalBeliefMap.set(b.id, b.text);
      }
      for (const g of delta.state.gaps as unknown as Array<Record<string, unknown>>) {
        if (typeof g.id === 'string' && typeof g.text === 'string')
          globalBeliefMap.set(g.id, g.text);
      }

      // Delta-scoped conflicts
      const allContradictions = delta.state.contradictions as unknown[];
      const newConflicts = allContradictions.filter(c => {
        const key = typeof c === 'string' ? c : String(c);
        return !seenContradictions.has(key);
      });
      for (const c of newConflicts)
        seenContradictions.add(typeof c === 'string' ? c : String(c));
      roundNewConflictCount += newConflicts.length;

      const conflictPairs = newConflicts.map(c => {
        const raw = typeof c === 'string' ? c : String(c);
        const m   = /^(.+?)\s+contradicts\s+(.+)$/i.exec(raw);
        if (m) {
          return {
            a: (globalBeliefMap.get(m[1].trim()) ?? m[1].trim()).slice(0, 120),
            b: (globalBeliefMap.get(m[2].trim()) ?? m[2].trim()).slice(0, 120),
          };
        }
        return {
          a: (globalBeliefMap.get(raw.trim()) ?? raw).slice(0, 120),
          b: '',
        };
      });

      console.log(
        `[debate] side_done side=${side} clarity=${delta.clarity.toFixed(3)} ` +
          `created=${created} new_conflicts=${newConflicts.length}`,
      );

      onEvent({
        type: 'side_done',
        side,
        label: sideLabel,
        created,
        clarity: delta.clarity,
        contradictions: newConflicts.length,
        conflictPairs,
      });

      if (side === 'pro') lastProDelta  = delta;
      else                lastAntiDelta = delta;

      await new Promise(res => setTimeout(res, 500)); // slightly longer delay to respect rate limits
    }

    const proC = lastProDelta!.clarity;
    const antiC = lastAntiDelta!.clarity;
    const contradictionsNow = lastAntiDelta!.state.contradictions.length;

    await resolveClosedGaps(lastAntiDelta!.state.gaps, moveTargetsThisRound);

    const newContradictions = lastAntiDelta!.state.contradictions.slice(previousContradictionCount);
    for (const c of newContradictions.slice(0, 3))
      await withRetry(() => judge.resolve(c)).catch(() => {});
    previousContradictionCount = lastAntiDelta!.state.contradictions.length;

    clarityHistory.push((proC + antiC) / 2);
    onEvent({
      type: 'round_done',
      round: roundNum,
      proClarity: proC,
      antiClarity: antiC,
      contradictions: roundNewConflictCount,
    });
    console.log(
      `[debate] round_done round=${roundNum} proC=${proC.toFixed(3)} ` +
        `antiC=${antiC.toFixed(3)} new_conflicts=${roundNewConflictCount} cumulative_contradictions=${contradictionsNow}`,
    );

    const recentDelta =
      clarityHistory.length >= 2
        ? Math.abs(clarityHistory.at(-1)! - clarityHistory.at(-2)!)
        : 1.0;

    if (plan.suggestStop) {
      onEvent({ type: 'early_exit', reason: 'Director suggests stopping — sufficient coverage reached.' });
      earlyExit = true;
    } else if (
      roundNum >= 4 &&
      recentDelta < 0.005 &&
      contradictionsNow >= CONTRADICTION_THRESHOLD
    ) {
      onEvent({
        type: 'early_exit',
        reason: `Clarity plateau (Δ=${recentDelta.toFixed(4)}) + ${contradictionsNow} contradictions — diminishing returns.`,
      });
      earlyExit = true;
    } else if (roundNum >= 3 && proC >= 0.7 && antiC >= 0.7) {
      onEvent({ type: 'early_exit', reason: 'Both sides at high clarity — sufficient evidence gathered.' });
      earlyExit = true;
    }
  }

  await new Promise(r => setTimeout(r, 400));

  // ── Judge reads the fused namespace ─────────────────────────────────────────
  const world = await withRetry(() => judge.read());

  const established = world.beliefs.filter(b => b.confidence > 0.7);
  const contested   = world.beliefs.filter(b => b.confidence >= 0.4 && b.confidence <= 0.7);
  const weak        = world.beliefs.filter(b => b.confidence < 0.4);

  onEvent({
    type: 'judge_state',
    totalBeliefs: world.beliefs.length,
    established: established.length,
    contested: contested.length,
    weak: weak.length,
    gaps: world.gaps,
    contradictionCount: world.contradictions.length,
  });
  console.log(
    `[debate] judge_state beliefs=${world.beliefs.length} established=${established.length} ` +
      `contested=${contested.length} weak=${weak.length} gaps=${world.gaps.length} ` +
      `contradictions=${world.contradictions.length}`,
  );

  // ── Verdict pre-grounding ────────────────────────────────────────────────────
  try {
    const synthesisQuery =
      world.gaps.length > 0
        ? `${config.topic} ${world.gaps[0].replace('Unknown: ', '')} evidence synthesis`
        : `${config.topic} expert consensus evidence 2024 2025`;
    const synthResults = await exa.searchAndContents(synthesisQuery, {
      numResults: 2,
      type: 'deep',
      text: { maxCharacters: 20000 },
    });
    const synthText = synthResults.results
      .filter(r => !seenUrls.has(r.url))
      .map(r => `[Source: ${r.title ?? r.url}]\n${(r as { text?: string }).text ?? ''}`)
      .filter(t => t.length > 300)
      .join('\n\n');
    if (synthText)
      await withRetry(() => judge.after(synthText, { tool: 'web_search' }));
  } catch {
    // Non-fatal
  }

  // ── Verdict — judge.before() is already correctly used here ─────────────────
  const verdict = await withRetry(() =>
    judge.before(
      `Based on all evidence from both sides: provide a balanced epistemic assessment of: ` +
        `"${config.topic}". What is well-established by the evidence, what is actively disputed, ` +
        `and what remains unknown or unresolved?`,
    )
  );

  try {
    const verdictStream = await openai.chat.completions.create({
      model: 'gpt-4o',
      stream: true,
      messages: [
        { role: 'system', content: verdict.prompt },
        {
          role: 'user',
          content:
            `Give a balanced, evidence-grounded verdict on: "${config.topic}". ` +
            `Cover: (1) what the evidence clearly supports, (2) what remains actively contested, ` +
            `(3) what is genuinely unknown. Cite specific findings where possible. ` +
            `End with a brief overall epistemic assessment (1–2 sentences).`,
        },
      ],
    });
    for await (const chunk of verdictStream) {
      const text = chunk.choices[0]?.delta?.content ?? '';
      if (text) onEvent({ type: 'verdict_chunk', text });
    }
  } catch {
    // Emit verdict_done even on error
  }
  onEvent({ type: 'verdict_done' });
  console.log('[debate] verdict_done — streaming complete');

  // ── Scorecard ────────────────────────────────────────────────────────────────
  onEvent({
    type: 'scorecard',
    proCreated:    score.pro.created,
    antiCreated:   score.anti.created,
    proClarity:    score.pro.clarityLast,
    antiClarity:   score.anti.clarityLast,
    contradictions: world.contradictions.length,
    gaps:           world.gaps.length,
    rounds:         roundNum,
    sources:        seenUrls.size,
    judgeClarity:   verdict.clarity,
  });

  onEvent({ type: 'done' });
}
