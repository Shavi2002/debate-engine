import { NextRequest } from 'next/server';
import { Exa } from 'exa-js';
import OpenAI from 'openai';
import { generateDebateConfig, runDebate } from '@/src/lib/debate-runner';
import type { DebateEvent } from '@/src/types/debate';

// Allow long-running debates (up to 10 minutes in production)
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function guardEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

export async function POST(req: NextRequest) {
  const { question } = (await req.json()) as { question: string };
  if (!question?.trim()) {
    return new Response(JSON.stringify({ error: 'question is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();

  function sseEvent(event: DebateEvent): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: DebateEvent) => {
        try {
          controller.enqueue(sseEvent(event));
        } catch {
          // Client disconnected
        }
      };

      try {
        const apiKey = guardEnv('BELIEFS_KEY');
        const exa = new Exa(guardEnv('EXA_API_KEY'));
        const openai = new OpenAI({ apiKey: guardEnv('OPENAI_API_KEY') });

        console.log(
          `[route] POST /api/debate question="${question.trim().slice(0, 80)}"`,
        );

        const config = await generateDebateConfig(question.trim(), openai);
        console.log(
          `[route] config generated topic="${config.topic}" sides=${config.sides.pro.label} vs ${config.sides.anti.label}`,
        );

        // Derive namespace slug the same way runDebate does
        const slug = config.topic
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 30)
          .replace(/-+$/, '');
        const namespace = `${slug}-preview`;
        emit({ type: 'config_ready', config, namespace });

        console.log(`[route] starting runDebate namespace=${namespace}`);
        await runDebate(config, { apiKey, exa, openai, onEvent: emit });
        console.log('[route] runDebate completed successfully');
      } catch (err) {
        console.error('[route] error during debate:', err);
        emit({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
