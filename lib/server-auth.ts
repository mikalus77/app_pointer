import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { POINTAGE_ERRORS } from './server-pointage-errors'
import { SESSION_COOKIE_NAME, type AppSession, verifySessionToken } from './session'

export async function getServerSession() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value
  return verifySessionToken(sessionToken)
}

export async function requireServerSession() {
  const session = await getServerSession()
  if (!session) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: POINTAGE_ERRORS.sessionExpired }, { status: 401 }),
    }
  }

  return {
    ok: true as const,
    session,
  }
}

export function buildUnauthorizedPointageResponse() {
  return NextResponse.json({ error: POINTAGE_ERRORS.sessionExpired }, { status: 401 })
}

export type RequiredServerSessionResult = {
  ok: true
  session: AppSession
}
