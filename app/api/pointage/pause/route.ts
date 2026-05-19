import { NextResponse } from 'next/server'
import { requireServerSession } from '../../../../lib/server-auth'
import { POINTAGE_ERRORS } from '../../../../lib/server-pointage-errors'
import { buildPointageErrorResponse, ensureSessionOwnership } from '../../../../lib/server-pointage'
import { createServerSupabaseClient } from '../../../../lib/server-supabase'

export async function POST(request: Request) {
  const authResult = await requireServerSession()
  if (!authResult.ok) {
    return authResult.response
  }

  try {
    const body = (await request.json()) as { sessionId?: number }
    const sessionId = Number(body.sessionId)

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.invalidSession)
    }

    const ownedSession = await ensureSessionOwnership(authResult.session.userId, sessionId)
    if (!ownedSession) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.sessionNotFound, 404)
    }

    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase.rpc('rpc_pointage_pause', {
      p_session_id: sessionId,
    })

    if (error || !data) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.pauseFailed, 500)
    }

    const row = Array.isArray(data) ? data[0] : data
    return NextResponse.json({
      id_pause_pointage: row?.id_pause_pointage ?? null,
      debut_pause_pointage: row?.debut_pause_pointage ?? null,
    })
  } catch {
    return buildPointageErrorResponse(POINTAGE_ERRORS.pauseFailed, 500)
  }
}
