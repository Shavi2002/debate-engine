# multi-agent-debate-system
# 🧠 Belief Debate Engine

> A multi-agent epistemic reasoning system that researches both sides of any question using live web sources, structured belief graphs, and semantic contradiction detection.

Built with [thinkn.ai beliefs SDK](https://thinkn.ai/dev) + [Exa](https://exa.ai) + GPT-4o.

---

## What It Does

Traditional LLM research accumulates text. This system accumulates **understanding**.

Two opposing agents (`pro` and `anti`) independently research a question via live web search. Every piece of content they ingest is parsed into **typed, confidence-weighted belief nodes** in a shared namespace. The SDK automatically:

- Detects semantic contradictions across sources that never reference each other
- Suppresses the clarity score when genuine epistemic conflict exists
- Tracks open gaps and ranks the highest-value next research actions
- Fuses multi-agent outputs into a single coherent world state

A third **judge** agent reads the fused namespace and produces a structured, evidence-grounded verdict via GPT-4o.

---

## Architecture

```
User Question
     │
     ▼
generateDebateConfig()          ← GPT-4o bootstraps sides, goal, 4 gaps, seed queries
     │
     ▼
┌──────────────────────────────────────────────┐
│               Shared Namespace               │
│                                              │
│  pro-agent ──► beliefs.after(webContent)     │
│  anti-agent ──► beliefs.after(webContent)    │
│                          │                  │
│              SDK fuses, scores, detects      │
│              contradictions automatically    │
└──────────────────────────────────────────────┘
     │
     ▼
judge.read()                    ← full fused belief graph
     │
     ├──► debateDirector()      ← GPT-4o reads world.moves[] → writes Exa queries
     │         │
     │         ▼
     │    Exa web search → beliefs.after() → repeat
     │
     ▼
judge.before()                  ← structured briefing prompt
     │
     ▼
GPT-4o Verdict                  ← grounded in belief graph, not raw web text
```

---

## SDK Methods Used

| Method | Where | Purpose |
|--------|-------|---------|
| `new Beliefs({ agent, namespace })` | `debate-runner.ts` | Three agents, one namespace — pro, anti, judge |
| `beliefs.add([...], { type: 'gap' })` | Seed phase | Bootstrap 4 investigable unknowns |
| `beliefs.add({ type: 'goal' })` | Seed phase | Set the debate objective |
| `beliefs.after(webContent)` | Per source | Extract beliefs from Exa page text |
| `beliefs.read()` | Director loop | Full world state: beliefs, gaps, contradictions, moves |
| `beliefs.before()` | Judge verdict | Structured system prompt for GPT-4o |
| `beliefs.resolve(gap)` | Per round | Close gaps answered by evidence |
| `beliefs.snapshot()` | UI polling | Lightweight state read without clarity recomputation |

### Multi-Agent Shared Namespace Pattern

```ts
const proAgent  = new Beliefs({ apiKey, agent: 'pro-smoking',  namespace: ns })
const antiAgent = new Beliefs({ apiKey, agent: 'anti-smoking', namespace: ns })
const judge     = new Beliefs({ apiKey, agent: 'judge',        namespace: ns })

// All three agents write to and read from the same belief graph.
// The SDK fuses their outputs automatically — no diff logic needed.
```

### Director Loop (rounds ≥ 3)

```ts
const world = await judge.read()
// world.moves[] are already ranked by expected information gain
// GPT-4o's only job is translating world.moves[0].target into Exa search strings

const plan = await debateDirector(world, roundNum)
// → { pro: { query1, query2 }, anti: { query1, query2 }, reasoning }
```

### Clarity-Suppression Under Conflict

Clarity is **not** a quality score — it's epistemic readiness, computed across four channels:

$$\text{clarity} = f(\underbrace{\text{decisionResolution}}_{\text{goals met}},\ \underbrace{\text{knowledgeCertainty}}_{\text{high-confidence beliefs}},\ \underbrace{\text{coherence}}_{\text{low contradictions}},\ \underbrace{\text{coverage}}_{\text{gaps closed}})$$

On contested topics, `coherence` stays suppressed. A clarity of `0.41` after 53 sources is **correct behavior** — the system knows it doesn't know.

---

## Projects

### `debate-ui/` — Next.js Web App

Live streaming debate UI with SSE event rendering.

```bash
cd debate-ui
cp .env.local.example .env.local   # fill in keys
npm install
npm run dev
# → http://localhost:3000
```

**Environment variables:**
```env
BELIEFS_KEY=bel_live_...
EXA_API_KEY=...
OPENAI_API_KEY=...
```

### `demos/` — SDK Demos (CLI)

Step-by-step walkthroughs of every SDK method.

```bash
cd demos
cp .env.example .env   # fill in BELIEFS_KEY
npm install

npm run 01    # add() — single belief
npm run 02    # add() — multiple types
npm run 03    # after() — extraction from prose
npm run 04    # before() — LLM priming
npm run 05    # read() vs snapshot()
npm run 06    # search()
npm run 07    # resolve() — closing a gap
npm run 08    # trace() — audit trail
npm run 09    # contradictions — multi-agent conflict
npm run 10    # core agent loop
npm run 11    # blocksworld — planning with beliefs
npm run 12    # EV debate — full debate with Exa
npm run 13    # open debate runner — any question
```

**Run any debate from CLI:**
```bash
npm run 13 -- "Will AI replace most human workers by 2035?"
```

### `political-lens/` — Multi-Source Bias Analyzer

Feeds the same news event from three editorially distinct outlets (optimist / neutral / skeptic) into a shared belief namespace and produces a structured clarity audit.

```bash
cd political-lens
npm install
BELIEFS_KEY=bel_live_... npm start
```

**Output includes:**
- Clarity score (0–1) with per-channel breakdown
- Claims sorted by confidence
- Cross-outlet contradictions detected
- Gaps none of the sources addressed
- Full belief transition trail via `trace()`

---

## Key Concepts

### Beliefs vs Memory

| Memory / RAG | Beliefs SDK |
|---|---|
| Stores text | Models understanding |
| No confidence tracking | Every claim has a confidence score |
| Silent contradictions | Explicit contradiction detection |
| No gap awareness | Gaps are first-class nodes |
| No readiness signal | `clarity` + `readiness` tell you when to act |

### Confidence Tiers (Judge Panel)

| Label | Range | Meaning |
|-------|-------|---------|
| **Established** | > 0.70 | Supported by multiple consistent sources |
| **Contested** | 0.40–0.70 | Claimed but contradicted or weakly supported |
| **Weak** | < 0.40 | Single source, low-confidence, or disputed |

### Early Exit Logic

The debate runner exits early when the SDK signals diminishing returns:

```ts
const shouldStop =
  world.moves.length === 0 ||          // no further high-value actions
  topMove.value < 0.1 ||               // expected gain near zero
  (world.gaps.length === 0 &&
   world.contradictions.length >= CONTRADICTION_THRESHOLD)
```

---

## Scorecard Fields

| Field | Description |
|-------|-------------|
| `Total beliefs` | All claim nodes in the fused namespace |
| `Established >0.70` | High-confidence, consistent beliefs |
| `Contested 0.40–0.70` | Disputed or partially supported |
| `Weak <0.40` | Low signal |
| `Contradictions` | Semantic conflicts detected across sources |
| `Open gaps` | Unknowns still unresolved |
| `Gaps resolved` | Gaps explicitly closed by evidence |
| `Judge clarity` | Overall epistemic readiness score |
| `Sources ingested` | Total Exa pages fed via `after()` |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| [`beliefs`](https://thinkn.ai/dev) | Epistemic belief state SDK |
| [`exa-js`](https://exa.ai) | Neural web search for real-time evidence |
| [`openai`](https://platform.openai.com) | GPT-4o for director + verdict |
| [`next`](https://nextjs.org) | Web UI (debate-ui) |

---

## Get API Keys

- **thinkn.ai**: [thinkn.ai/profile/api-keys](https://thinkn.ai/profile/api-keys)
- **Exa**: [dashboard.exa.ai](https://dashboard.exa.ai)
- **OpenAI**: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

---

## Further Reading

- [Why beliefs over memory?](https://thinkn.ai/dev/why/problem)
- [Full SDK API reference](https://thinkn.ai/dev/sdk/core-api)
- [Framework integration patterns](https://thinkn.ai/dev/sdk/patterns)
- [Vercel AI adapter](https://thinkn.ai/dev/adapters/vercel-ai)
- [Claude Agent SDK adapter](https://thinkn.ai/dev/adapters/claude-agent-sdk)
- [Hackathon guide](https://thinkn.ai/dev/start/hack-guide)
