import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from './server-supabase'

export function buildPointageErrorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export async function ensurePointageOwnership(userId: number, pointageId: number) {
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('pointage')
    .select('id_pointage')
    .eq('id_pointage', pointageId)
    .eq('id_utilisateur_pointeur', userId)
    .maybeSingle()

  if (error || !data) {
    return null
  }

  return data
}

export async function ensureSessionOwnership(userId: number, sessionId: number) {
  const supabase = createServerSupabaseClient()
  const { data: sessionRow, error: sessionError } = await supabase
    .from('session_pointage')
    .select('id_session_pointage, id_pointage')
    .eq('id_session_pointage', sessionId)
    .maybeSingle()

  if (sessionError || !sessionRow) {
    return null
  }

  const pointageRow = await ensurePointageOwnership(userId, sessionRow.id_pointage)
  if (!pointageRow) {
    return null
  }

  return sessionRow
}

export async function ensurePauseOwnership(userId: number, pauseId: number) {
  const supabase = createServerSupabaseClient()
  const { data: pauseRow, error: pauseError } = await supabase
    .from('pause_pointage')
    .select('id_pause_pointage, id_session_pointage')
    .eq('id_pause_pointage', pauseId)
    .maybeSingle()

  if (pauseError || !pauseRow) {
    return null
  }

  const sessionRow = await ensureSessionOwnership(userId, pauseRow.id_session_pointage)
  if (!sessionRow) {
    return null
  }

  return pauseRow
}
