import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { SESSION_COOKIE_NAME, verifySessionToken } from '../../../../lib/session'

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value

  const session = await verifySessionToken(sessionToken)
  if (!session) {
    const response = NextResponse.json({ error: 'Session invalide.' }, { status: 401 })
    response.cookies.delete(SESSION_COOKIE_NAME)
    return response
  }

  return NextResponse.json({
    userId: session.userId,
    username: session.username,
    expiresAt: session.expiresAt,
  })
}
