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
    const body = (await request.json()) as { pointageDate?: string }
    const pointageDate = body.pointageDate?.trim() ?? ''

    if (!/^\d{4}-\d{2}-\d{2}$/.test(pointageDate)) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.invalidPointageDate)
    }

    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase.rpc('rpc_pointage_validate_day', {
      p_user_id: authResult.session.userId,
      p_pointage_date: pointageDate,
    })

    if (error || typeof data !== 'number') {
      return buildPointageErrorResponse(POINTAGE_ERRORS.validateFailed, 500)
    }

    return NextResponse.json({ validatedCount: data })
  } catch {
    return buildPointageErrorResponse(POINTAGE_ERRORS.validateFailed, 500)
  }
}
