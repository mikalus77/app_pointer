import { NextResponse } from 'next/server'
import { requireServerSession } from '../../../../lib/server-auth'
import { POINTAGE_ERRORS } from '../../../../lib/server-pointage-errors'
import { buildPointageErrorResponse } from '../../../../lib/server-pointage'
import { createServerSupabaseClient } from '../../../../lib/server-supabase'

export async function POST(request: Request) {
  const authResult = await requireServerSession()
  if (!authResult.ok) {
    return authResult.response
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      workGraceMinutes?: number
      pauseMaxMinutes?: number
    }

    const workGraceMinutes = Number.isFinite(body.workGraceMinutes)
      ? Number(body.workGraceMinutes)
      : 10
    const pauseMaxMinutes = Number.isFinite(body.pauseMaxMinutes)
      ? Number(body.pauseMaxMinutes)
      : 70

    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase.rpc('rpc_pointage_apply_auto_closure', {
      p_user_id: authResult.session.userId,
      p_work_grace_minutes: workGraceMinutes,
      p_pause_max_minutes: pauseMaxMinutes,
    })

    if (error || !data) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.autoClosureFailed, 500)
    }

    const rows = Array.isArray(data) ? data : [data]
    return NextResponse.json({ rows })
  } catch {
    return buildPointageErrorResponse(POINTAGE_ERRORS.autoClosureFailed, 500)
  }
}
