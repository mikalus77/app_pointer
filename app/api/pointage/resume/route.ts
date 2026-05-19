import { NextResponse } from 'next/server'
import { requireServerSession } from '../../../../lib/server-auth'
import { POINTAGE_ERRORS } from '../../../../lib/server-pointage-errors'
import { buildPointageErrorResponse, ensurePauseOwnership } from '../../../../lib/server-pointage'
import { createServerSupabaseClient } from '../../../../lib/server-supabase'

export async function POST(request: Request) {
  const authResult = await requireServerSession()
  if (!authResult.ok) {
    return authResult.response
  }

  try {
    const body = (await request.json()) as {
      pauseId?: number
      pauseComment?: string | null
    }
    const pauseId = Number(body.pauseId)
    const pauseComment = body.pauseComment?.trim() || null

    if (!Number.isInteger(pauseId) || pauseId <= 0) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.invalidPause)
    }

    const ownedPause = await ensurePauseOwnership(authResult.session.userId, pauseId)
    if (!ownedPause) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.pauseNotFound, 404)
    }

    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase.rpc('rpc_pointage_resume', {
      p_pause_id: pauseId,
      p_pause_comment: pauseComment,
    })

    if (error || !data) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.resumeFailed, 500)
    }

    const row = Array.isArray(data) ? data[0] : data
    return NextResponse.json({
      fin_pause_pointage: row?.fin_pause_pointage ?? null,
    })
  } catch {
    return buildPointageErrorResponse(POINTAGE_ERRORS.resumeFailed, 500)
  }
}
