import { NextRequest, NextResponse } from 'next/server';

const requestCounts = new Map<string, { count: number; resetAt: number }>();

const LIMITS: Record<string, { max: number; windowMs: number }> = {
  '/api/debate': { max: 5, windowMs: 60 * 60 * 1000 },
  '/api/report': { max: 10, windowMs: 60 * 60 * 1000 },
};

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

export function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  const limit = LIMITS[pathname];
  if (!limit || req.method !== 'POST') return NextResponse.next();

  const ip = getClientIp(req);
  const key = `${ip}:${pathname}`;
  const now = Date.now();
  const current = requestCounts.get(key);

  if (!current || now > current.resetAt) {
    requestCounts.set(key, { count: 1, resetAt: now + limit.windowMs });
    return NextResponse.next();
  }

  if (current.count >= limit.max) {
    const retryAfterSec = Math.ceil((current.resetAt - now) / 1000);
    return NextResponse.json(
      {
        error: 'Rate limit exceeded',
        message: `Too many requests. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
      },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } }
    );
  }

  current.count++;
  requestCounts.set(key, current);
  return NextResponse.next();
}

export const config = {
  matcher: ['/api/debate', '/api/report'],
};
