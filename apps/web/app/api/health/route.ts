import { NextResponse } from 'next/server'

// Rendered per request: a static answer would stay "ok" after the server died.
export const dynamic = 'force-dynamic'

/** Public liveness check for status.profullstack.com. diskpush has no database. */
export function GET() {
  return NextResponse.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } })
}
