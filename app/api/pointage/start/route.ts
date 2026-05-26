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
    const body = (await request.json()) as {
      taskId?: number
      pointageDate?: string
      freeTaskLabel?: string | null
    }

    const taskId = Number(body.taskId)
    const pointageDate = body.pointageDate?.trim() ?? ''
    const freeTaskLabel = body.freeTaskLabel?.trim() || null

    if (!Number.isInteger(taskId) || taskId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(pointageDate)) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.startInvalidParams)
    }

    const supabase = createServerSupabaseClient()
    const normalizedFreeTaskLabel = freeTaskLabel

    const { data: userPointages, error: userPointagesError } = await supabase
      .from('pointage')
      .select('id_pointage')
      .eq('id_utilisateur_pointeur', authResult.session.userId)

    if (userPointagesError) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.startFailed, 500)
    }

    if (userPointages && userPointages.length > 0) {
      const pointageIds = userPointages.map((row) => row.id_pointage)
      const { data: activeSessions, error: activeSessionsError } = await supabase
        .from('session_pointage')
        .select('id_session_pointage, id_pointage, debut_session_pointage')
        .in('id_pointage', pointageIds)
        .is('fin_session_pointage', null)
        .order('debut_session_pointage', { ascending: false })
        .limit(1)

      if (activeSessionsError) {
        return buildPointageErrorResponse(POINTAGE_ERRORS.startFailed, 500)
      }

      if (activeSessions && activeSessions.length > 0) {
        const activeSession = activeSessions[0]
        return NextResponse.json({
          id_pointage: activeSession.id_pointage,
          id_session_pointage: activeSession.id_session_pointage,
          debut_session_pointage: activeSession.debut_session_pointage ?? null,
          existing_active: true,
        })
      }
    }

    const { data: statusRow, error: statusError } = await supabase
      .from('statut_pointage')
      .select('id_statut_pointage')
      .eq('code_statut_pointage', 'EN_COURS')
      .single()

    if (statusError || !statusRow) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.statusEnCoursMissing, 500)
    }

    const pointageQuery = supabase
      .from('pointage')
      .select('id_pointage')
      .eq('id_utilisateur_pointeur', authResult.session.userId)
      .eq('id_tache', taskId)
      .eq('date_pointage', pointageDate)
      .eq('id_statut_pointage', statusRow.id_statut_pointage)
      .order('id_pointage', { ascending: true })
      .limit(1)

    const { data: existingPointageRows, error: existingPointageError } = normalizedFreeTaskLabel
      ? await pointageQuery.eq('libelle_tache_libre_pointage', normalizedFreeTaskLabel)
      : await pointageQuery.is('libelle_tache_libre_pointage', null)

    if (existingPointageError) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.startFailed, 500)
    }

    let pointageId =
      existingPointageRows && existingPointageRows.length > 0
        ? existingPointageRows[0].id_pointage
        : null

    if (pointageId === null) {
      const { data: insertedPointage, error: insertPointageError } = await supabase
        .from('pointage')
        .insert({
          id_utilisateur_pointeur: authResult.session.userId,
          id_utilisateur_traitement: null,
          id_tache: taskId,
          id_statut_pointage: statusRow.id_statut_pointage,
          date_pointage: pointageDate,
          date_traitement_pointage: null,
          remarque_admin_pointage: null,
          libelle_tache_libre_pointage: normalizedFreeTaskLabel,
        })
        .select('id_pointage')
        .single()

      if (insertPointageError || !insertedPointage) {
        return buildPointageErrorResponse(insertPointageError?.message || POINTAGE_ERRORS.startFailed, 500)
      }

      pointageId = insertedPointage.id_pointage
    }

    const nowIso = new Date().toISOString()
    const { data: insertedSession, error: insertSessionError } = await supabase
      .from('session_pointage')
      .insert({
        id_pointage: pointageId,
        debut_session_pointage: nowIso,
        fin_session_pointage: null,
        commentaire_session_pointage: null,
        last_seen_session_pointage: nowIso,
      })
      .select('id_session_pointage, debut_session_pointage')
      .single()

    if (insertSessionError || !insertedSession) {
      return buildPointageErrorResponse(insertSessionError?.message || POINTAGE_ERRORS.startFailed, 500)
    }

    return NextResponse.json({
      id_pointage: pointageId,
      id_session_pointage: insertedSession.id_session_pointage,
      debut_session_pointage: insertedSession.debut_session_pointage ?? nowIso,
      existing_active: false,
    })
  } catch {
    return buildPointageErrorResponse(POINTAGE_ERRORS.startFailed, 500)
  }
}
