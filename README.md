# 🧠 Debate Engine

> A multi-agent epistemic reasoning system that researches both sides of any question using live web sources, structured belief graphs, and semantic contradiction detection.

Built with [thinkn.ai beliefs SDK](https://thinkn.ai/dev) + [Exa](https://exa.ai) + GPT-4o.
Uses thinkn.ai as the core framework to simulate a (bi-opinion) debate using multiple agents that put equal weight on advocating for and against the topic. By connecting agents to EXA API the real content like articles, research papers, blogs are pulled from the internet and fed to a belief system that semantically manages arguments, identifies contradictions and resolves knowledge gaps autonomously by pursuing the promising query directions, continuously evolving and expanding over time as more and more data is collected. The system tries to minimize confusion, maximize clarity and summarizes grounded findings at the very end.

# [DEMO VIDEO](https://youtu.be/cgeO4PT6tQg?si=DvboGAyMCYeT7xOf)

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
│                          │                   │
│              SDK fuses, scores, detects       │
│              contradictions automatically     │
└──────────────────────────────────────────────┘
     │
     ▼
judge.read()                    ← full fused belief graph
     │
     ├──► debateDirector()      ← GPT-4o reads world.moves[] → writes Exa queries
     │         │
     │         ▼
     │    Exa web search → beliefs.after() → repeat N rounds
     │
     ▼
judge.before()                  ← structured briefing prompt injected into GPT-4o
     │
     ▼
GPT-4o Verdict                  ← grounded in belief graph, not raw web text
```

---

## Project Structure

```
debate-ui/
├── app/
│   ├── page.tsx                  # Main UI — live SSE rendering
│   ├── api/
│   │   ├── debate/route.ts       # SSE stream — runs the debate loop
│   │   └── verdict/route.ts      # Judge verdict endpoint
├── src/
│   └── lib/
│       └── debate-runner.ts      # Core debate logic
└── .env.local                    # API keys
```

---

## How It Works

### 1. Config Bootstrap
GPT-4o takes the user's question and generates the debate configuration:
- Two named sides (pro / anti) with distinct research angles
- A single overarching goal node
- 4 investigable gap nodes (things the system doesn't know yet)
- Seed search queries for round 1

### 2. Belief Agents — Shared Namespace
```ts
const proAgent  = new Beliefs({ apiKey, agent: 'pro',   namespace: ns })
const antiAgent = new Beliefs({ apiKey, agent: 'anti',  namespace: ns })
const judge     = new Beliefs({ apiKey, agent: 'judge', namespace: ns })

// All three agents write to and read from the same belief graph.
// The SDK fuses their outputs — no manual diffing needed.
```

### 3. The Round Loop
Each round:
1. `judge.read()` — snapshot the full world state
2. `debateDirector()` — GPT-4o reads `world.moves[]` (ranked by expected information gain) and writes Exa queries
3. Both agents run Exa searches in parallel
4. Each result page is fed into `agent.after(webContent)` — the SDK extracts beliefs, scores confidence, detects contradictions
5. Resolved gaps are closed with `beliefs.resolve(gap)`
6. State is streamed to the UI via SSE

### 4. Early Exit
The runner exits when the SDK signals diminishing returns:
```ts
const shouldStop =
  world.moves.length === 0          ||  // no further high-value actions
  topMove.value < 0.1               ||  // expected information gain near zero
  (world.gaps.length === 0 &&
   world.contradictions.length >= CONTRADICTION_THRESHOLD)
```

### 5. Judge Verdict
```ts
const context = await judge.before()   // structured belief-graph briefing
// context.prompt is injected into GPT-4o as system prompt
// The LLM summarises the belief graph, not the raw web
```

---

## SDK Methods

| Method | Purpose |
|--------|---------|
| `new Beliefs({ agent, namespace })` | Three agents sharing one namespace |
| `beliefs.add([...], { type: 'gap' })` | Seed 4 investigable unknowns |
| `beliefs.add({ type: 'goal' })` | Set the debate objective |
| `beliefs.after(webContent)` | Extract + fuse beliefs from Exa page text |
| `beliefs.read()` | Full world state: beliefs, gaps, contradictions, moves |
| `beliefs.before()` | Structured system prompt for GPT-4o verdict |
| `beliefs.resolve(gap)` | Explicitly close a gap answered by evidence |
| `beliefs.snapshot()` | Lightweight state read for UI polling |

---

## The Clarity Score

Clarity is **not** a quality score — it's epistemic readiness, computed across four channels:

$$\text{clarity} = f(\underbrace{\text{decisionResolution}}_{\text{goals met}},\ \underbrace{\text{knowledgeCertainty}}_{\text{high-confidence beliefs}},\ \underbrace{\text{coherence}}_{\text{low contradictions}},\ \underbrace{\text{coverage}}_{\text{gaps closed}})$$

> A clarity of `0.41` after 53 ingested sources is **correct behavior** — on a genuinely contested topic, the `coherence` channel stays suppressed. The system knows it doesn't know.

---

## UI Walkthrough

### Header — Scorecard
| Field | Description |
|-------|-------------|
| `Total beliefs` | All claim nodes in the fused namespace |
| `Established >0.70` | High-confidence, consistent beliefs |
| `Contested 0.40–0.70` | Disputed or partially supported |
| `Weak <0.40` | Low signal — single source or contradicted |
| `Contradictions` | Semantic conflicts detected across sources |
| `Open gaps` | Unknowns still unresolved |
| `Gaps resolved` | Gaps explicitly closed via `beliefs.resolve()` |
| `Judge clarity` | Overall epistemic readiness (0–1) |
| `Sources ingested` | Total Exa pages fed via `after()` |

### Round Cards
- **Director line** (cyan italic) — GPT-4o's reasoning from `world.moves[]`
- **Next-round value** — SDK's expected information gain for the next round
- **Source list** — Exa pages fed into `beliefs.after()`
- **⚡ Conflicts badge** — contradictions detected in this round
- **WHAT CONFLICTED** — the specific belief pairs that semantically negate each other
- **Clarity bars** — per-agent clarity after round completion
- **Resolved chip** (green) — gap closed this round via `beliefs.resolve()`

### GPT-4o Verdict
Verdict sections map directly to belief graph confidence tiers — the structure comes from the SDK, not prompt engineering:

| Verdict Section | Belief Tier |
|----------------|-------------|
| Evidence clearly supports | Established `> 0.70` |
| Actively contested | Contested `0.40–0.70` |
| Genuinely unknown | Open gaps |

---

## Setup

```bash
cd debate-ui
cp .env.local.example .env.local
npm install
npm run dev
# → http://localhost:3000
```

**.env.local**
```env
BELIEFS_KEY=bel_live_...
EXA_API_KEY=...
OPENAI_API_KEY=...
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| [`beliefs`](https://thinkn.ai/dev) | Epistemic belief state SDK |
| [`exa-js`](https://exa.ai) | Neural web search for real-time evidence |
| [`openai`](https://platform.openai.com) | GPT-4o for director reasoning + verdict |
| [`next`](https://nextjs.org) | Web UI + SSE streaming |

---

## Get API Keys

- **thinkn.ai**: [thinkn.ai/profile/api-keys](https://thinkn.ai/profile/api-keys)
- **Exa**: [dashboard.exa.ai](https://dashboard.exa.ai)
- **OpenAI**: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

---

## Further Reading

- [Why beliefs over memory?](https://thinkn.ai/dev/why/problem)
- [Full SDK reference](https://thinkn.ai/dev)
- [Hackathon guide](https://thinkn.ai/dev/start/hack-guide)
