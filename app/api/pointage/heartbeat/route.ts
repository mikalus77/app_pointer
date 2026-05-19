import { NextResponse } from 'next/server'
import { requireServerSession } from '../../../../lib/server-auth'
import { POINTAGE_ERRORS } from '../../../../lib/server-pointage-errors'
import { buildPointageErrorResponse } from '../../../../lib/server-pointage'
import { createServerSupabaseClient } from '../../../../lib/server-supabase'

export async function POST() {
  const authResult = await requireServerSession()
  if (!authResult.ok) {
    return authResult.response
  }

  try {
    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase.rpc('rpc_pointage_heartbeat', {
      p_user_id: authResult.session.userId,
    })

    if (error) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.heartbeatFailed, 500)
    }

    const row = Array.isArray(data) ? data[0] : data
    return NextResponse.json({
      active_session_id: row?.active_session_id ?? null,
      active_pause_id: row?.active_pause_id ?? null,
      heartbeat_at: row?.heartbeat_at ?? null,
    })
  } catch {
    return buildPointageErrorResponse(POINTAGE_ERRORS.heartbeatFailed, 500)
  }
}
