import { NextRequest, NextResponse } from 'next/server';
import type { BeliefSnapshot } from '@/src/lib/persistence';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

function guardEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

interface ReportRequest {
  snapshot: BeliefSnapshot;
  format: 'pdf' | 'docx' | 'markdown';
  style: 'academic' | 'executive' | 'technical';
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ReportRequest;
    const { snapshot, format, style } = body;

    if (!snapshot) {
      return NextResponse.json(
        { error: 'snapshot is required' },
        { status: 400 }
      );
    }

    const openaiKey = guardEnv('OPENAI_API_KEY');
    const systemPrompt = buildSystemPrompt(style);
    const userPrompt = buildUserPrompt(snapshot);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI error: ${response.status}`);
    }

    const data = await response.json();
    const reportMarkdown = data.choices[0].message.content as string;

    return NextResponse.json({
      markdown: reportMarkdown,
      format,
      metadata: {
        topic: snapshot.topic,
        generatedAt: new Date().toISOString(),
        totalBeliefs: snapshot.totalBeliefs,
        sources: snapshot.sources,
        rounds: snapshot.rounds,
      },
    });
  } catch (err) {
    console.error('[report] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

function buildSystemPrompt(style: string): string {
  const styleGuides: Record<string, string> = {
    academic: `You are a research analyst producing an academic-style report.
Use formal language, numbered citations in [N] format, structured sections with clear
headings, and include methodology, findings, contradictions, and limitations sections.
Be rigorous and precise. Every major claim should reference a source.`,
    executive: `You are a strategic analyst producing an executive briefing.
Use clear, concise language. Lead with the bottom line. Use bullet points for key
findings. Include an executive summary, key conclusions, and strategic implications.
Avoid jargon. Make it scannable and actionable.`,
    technical: `You are a technical researcher producing a detailed technical report.
Include data tables, confidence scores, contradiction analysis, and methodology details.
Use precise technical language. Structure with detailed subsections.
Highlight uncertainty ranges and data quality issues.`,
  };

  return (
    (styleGuides[style] || styleGuides.academic) +
    `\n\nOutput FORMAT REQUIREMENTS:
- Use Markdown with proper headings (## for main sections, ### for subsections)
- Include a title, date, and executive summary at the top
- Number all citations as [1], [2], etc.
- Include a References section at the end with all sources
- Include a Methodology section explaining the AI debate process
- Minimum 1500 words, maximum 4000 words`
  );
}

function buildUserPrompt(snapshot: BeliefSnapshot): string {
  const date = new Date(snapshot.timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const sourcesSection =
    snapshot.allSources.length > 0
      ? snapshot.allSources
          .slice(0, 60)
          .map((s, i) => `[${i + 1}] ${s.title || s.url} — ${s.url}`)
          .join('\n')
      : 'No sources recorded.';

  const conflictsSection =
    snapshot.allConflicts.length > 0
      ? snapshot.allConflicts
          .slice(0, 15)
          .map(
            (c, i) =>
              `Conflict ${i + 1}:\n  A: "${c.a}"\n  B: "${c.b}"`
          )
          .join('\n\n')
      : 'No direct contradictions detected.';

  return `Generate a comprehensive research report for the following debate analysis.

TOPIC: "${snapshot.topic}"
DATE: ${date}

BELIEF GRAPH STATISTICS:
- Total beliefs extracted: ${snapshot.totalBeliefs}
- Established (confidence >0.70): ${snapshot.established}
- Contested (confidence 0.40-0.70): ${snapshot.contested}
- Weak (confidence <0.40): ${snapshot.weak}
- Semantic contradictions detected: ${snapshot.contradictions}
- Research rounds completed: ${snapshot.rounds}
- Web sources ingested: ${snapshot.sources}
- Judge clarity score: ${snapshot.judgeClarity.toFixed(3)} / 1.000
- PRO agent final clarity: ${snapshot.proClarity.toFixed(3)}
- ANTI agent final clarity: ${snapshot.antiClarity.toFixed(3)}

OPEN KNOWLEDGE GAPS:
${snapshot.gaps.length > 0 ? snapshot.gaps.map((g) => `- ${g}`).join('\n') : '- None remaining'}

RESOLVED KNOWLEDGE GAPS:
${snapshot.resolvedGaps.length > 0 ? snapshot.resolvedGaps.map((g) => `- ${g}`).join('\n') : '- None explicitly resolved'}

SEMANTIC CONTRADICTIONS DETECTED:
${conflictsSection}

GPT-4o VERDICT:
${snapshot.verdictText || 'No verdict available.'}

SOURCES INGESTED (${snapshot.allSources.length} total, showing first 60):
${sourcesSection}

Please generate a comprehensive, fully-cited research report based on this data.
Cite the specific sources listed above using [N] notation.`;
}
