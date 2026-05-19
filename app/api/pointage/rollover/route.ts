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
      pauseId?: number | null
      mode?: 'running' | 'paused'
      sessionComment?: string | null
      pauseComment?: string | null
      sessionEndIso?: string
      nextSessionStartIso?: string
      nextPointageDate?: string
    }

    const sessionId = Number(body.sessionId)
    const pauseId =
      typeof body.pauseId === 'number' && Number.isInteger(body.pauseId) ? body.pauseId : null
    const mode = body.mode === 'paused' ? 'paused' : 'running'
    const sessionComment = body.sessionComment?.trim() || null
    const pauseComment = body.pauseComment?.trim() || null
    const sessionEndIso = body.sessionEndIso?.trim() ?? ''
    const nextSessionStartIso = body.nextSessionStartIso?.trim() ?? ''
    const nextPointageDate = body.nextPointageDate?.trim() ?? ''

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0 ||
      !sessionEndIso ||
      !nextSessionStartIso ||
      !/^\d{4}-\d{2}-\d{2}$/.test(nextPointageDate)
    ) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.rolloverInvalidParams)
    }

    const ownedSession = await ensureSessionOwnership(authResult.session.userId, sessionId)
    if (!ownedSession) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.sessionNotFound, 404)
    }

    if (mode === 'paused') {
      if (pauseId === null) {
        return buildPointageErrorResponse(POINTAGE_ERRORS.invalidPause, 400)
      }
      const ownedPause = await ensurePauseOwnership(authResult.session.userId, pauseId)
      if (!ownedPause || ownedPause.id_session_pointage !== sessionId) {
        return buildPointageErrorResponse(POINTAGE_ERRORS.invalidPauseForSession, 400)
      }
    }

    const supabase = createServerSupabaseClient()
    const { data: currentPointageRow, error: currentPointageError } = await supabase
      .from('pointage')
      .select('id_pointage, id_tache, libelle_tache_libre_pointage')
      .eq('id_pointage', ownedSession.id_pointage)
      .eq('id_utilisateur_pointeur', authResult.session.userId)
      .single()

    if (currentPointageError || !currentPointageRow) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.rolloverCurrentPointageMissing, 404)
    }

    if (mode === 'paused' && pauseId !== null) {
      const { error: pauseUpdateError } = await supabase
        .from('pause_pointage')
        .update({
          fin_pause_pointage: sessionEndIso,
          commentaire_pause_pointage: pauseComment,
          last_seen_pause_pointage: sessionEndIso,
        })
        .eq('id_pause_pointage', pauseId)
        .is('fin_pause_pointage', null)

      if (pauseUpdateError) {
        return buildPointageErrorResponse(POINTAGE_ERRORS.rolloverClosePauseFailed, 500)
      }
    }

    const { error: sessionUpdateError } = await supabase
      .from('session_pointage')
      .update({
        fin_session_pointage: sessionEndIso,
        commentaire_session_pointage: sessionComment,
        last_seen_session_pointage: sessionEndIso,
      })
      .eq('id_session_pointage', sessionId)
      .is('fin_session_pointage', null)

    if (sessionUpdateError) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.rolloverCloseSessionFailed, 500)
    }

    const { data: statusRow, error: statusError } = await supabase
      .from('statut_pointage')
      .select('id_statut_pointage')
      .eq('code_statut_pointage', 'EN_COURS')
      .eq('actif', true)
      .single()

    if (statusError || !statusRow) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.statusEnCoursMissing, 500)
    }

    const nextPointageQuery = supabase
      .from('pointage')
      .select('id_pointage')
      .eq('id_utilisateur_pointeur', authResult.session.userId)
      .eq('id_tache', currentPointageRow.id_tache)
      .eq('date_pointage', nextPointageDate)
      .eq('id_statut_pointage', statusRow.id_statut_pointage)
      .order('id_pointage', { ascending: true })
      .limit(1)

    const normalizedFreeTaskLabel = currentPointageRow.libelle_tache_libre_pointage?.trim() || null
    const { data: nextPointageRows, error: nextPointageLookupError } = normalizedFreeTaskLabel
      ? await nextPointageQuery.eq('libelle_tache_libre_pointage', normalizedFreeTaskLabel)
      : await nextPointageQuery.is('libelle_tache_libre_pointage', null)

    if (nextPointageLookupError) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.rolloverPrepareFailed, 500)
    }

    let nextPointageId =
      nextPointageRows && nextPointageRows.length > 0 ? nextPointageRows[0].id_pointage : null

    if (nextPointageId === null) {
      const { data: nextPointageRow, error: nextPointageInsertError } = await supabase
        .from('pointage')
        .insert({
          id_utilisateur_pointeur: authResult.session.userId,
          id_utilisateur_traitement: null,
          id_tache: currentPointageRow.id_tache,
          id_statut_pointage: statusRow.id_statut_pointage,
          date_pointage: nextPointageDate,
          date_traitement_pointage: null,
          remarque_admin_pointage: null,
          libelle_tache_libre_pointage: normalizedFreeTaskLabel,
        })
        .select('id_pointage')
        .single()

      if (nextPointageInsertError || !nextPointageRow) {
        return buildPointageErrorResponse(POINTAGE_ERRORS.rolloverPrepareFailed, 500)
      }

      nextPointageId = nextPointageRow.id_pointage
    }

    const { data: nextSessionRow, error: nextSessionError } = await supabase
      .from('session_pointage')
      .insert({
        id_pointage: nextPointageId,
        debut_session_pointage: nextSessionStartIso,
        fin_session_pointage: null,
        commentaire_session_pointage: null,
        last_seen_session_pointage: nextSessionStartIso,
      })
      .select('id_session_pointage, debut_session_pointage')
      .single()

    if (nextSessionError || !nextSessionRow) {
      return buildPointageErrorResponse(POINTAGE_ERRORS.rolloverOpenSessionFailed, 500)
    }

    let nextPauseRow: { id_pause_pointage: number; debut_pause_pointage: string | null } | null = null
    if (mode === 'paused') {
      const { data: insertedPauseRow, error: nextPauseError } = await supabase
        .from('pause_pointage')
        .insert({
          id_session_pointage: nextSessionRow.id_session_pointage,
          debut_pause_pointage: nextSessionStartIso,
          fin_pause_pointage: null,
          commentaire_pause_pointage: null,
          last_seen_pause_pointage: nextSessionStartIso,
        })
        .select('id_pause_pointage, debut_pause_pointage')
        .single()

      if (nextPauseError || !insertedPauseRow) {
        return buildPointageErrorResponse(POINTAGE_ERRORS.rolloverOpenPauseFailed, 500)
      }

      nextPauseRow = insertedPauseRow
    }

    return NextResponse.json({
      nextPointageId,
      nextSessionPointageId: nextSessionRow.id_session_pointage,
      nextSessionStartedAtIso: nextSessionRow.debut_session_pointage ?? nextSessionStartIso,
      nextPausePointageId: nextPauseRow?.id_pause_pointage ?? null,
      nextPauseStartedAtIso: nextPauseRow?.debut_pause_pointage ?? null,
    })
  } catch {
    return buildPointageErrorResponse(POINTAGE_ERRORS.rolloverFailed, 500)
  }
}
