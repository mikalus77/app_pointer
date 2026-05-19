import { NextResponse } from 'next/server'
import { requireServerSession } from '../../../../lib/server-auth'
import { POINTAGE_ERRORS } from '../../../../lib/server-pointage-errors'
import {
  buildPointageErrorResponse,
  ensurePauseOwnership,
  ensureSessionOwnership,
} from '../../../../lib/server-pointage'
import { createServerSupabaseClient } from '../../../../lib/server-supabase'

export async function POST(request: Request) {
  const authResult = await requireServerSession()
  if (!authResult.ok) {
    return authResult.response
  }

  try {
    const body = (await request.json()) as {
      sessionId?: number
      sessionComment?: string | null
      pauseId?: number | null
      pauseComment?: string | null
    }

    const sessionId = Number(body.sessionId)
    const pauseId =
      typeof body.pauseId === 'number' && Number.isInteger(body.pauseId) ? body.pauseId : null
    const sessionComment = body.sessionComment?.trim() || null
    const pauseComment = body.pauseComment?.trim() || null

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.invalidSession)
    }

    const ownedSession = await ensureSessionOwnership(authResult.session.userId, sessionId)
    if (!ownedSession) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.sessionNotFound, 404)
    }

    if (pauseId !== null) {
      const ownedPause = await ensurePauseOwnership(authResult.session.userId, pauseId)
      if (!ownedPause || ownedPause.id_session_pointage !== sessionId) {
        return buildPointageErrorResponse(POINTAGE_ERRORS.invalidPauseForSession, 400)
      }
    }

    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase.rpc('rpc_pointage_stop', {
      p_session_id: sessionId,
      p_session_comment: sessionComment,
      p_pause_id: pauseId,
      p_pause_comment: pauseComment,
    })

    if (error || !data) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.stopFailed, 500)
    }

    const row = Array.isArray(data) ? data[0] : data
    return NextResponse.json({
      fin_session_pointage: row?.fin_session_pointage ?? null,
      fin_pause_pointage: row?.fin_pause_pointage ?? null,
    })
  } catch {
    return buildPointageErrorResponse(POINTAGE_ERRORS.stopFailed, 500)
  }
}
