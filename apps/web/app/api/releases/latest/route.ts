import { NextResponse } from 'next/server'
import { latestRelease } from '@/lib/releases'

export const revalidate = 60

/**
 * Normalised latest-release metadata, so the download UI never has to know
 * GitHub's response shape.
 */
export async function GET() {
  const release = await latestRelease()
  if (!release) {
    return NextResponse.json(
      { version: null, publishedAt: null, assets: { linuxAppImage: null, linuxDeb: null, macDmg: null, windowsExe: null } },
      { headers: { 'Cache-Control': 'public, s-maxage=600' } },
    )
  }
  return NextResponse.json(release, { headers: { 'Cache-Control': 'public, s-maxage=60' } })
}
