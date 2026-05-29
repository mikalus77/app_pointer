'use client'

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { AppShell } from '../../components/app-shell'
import type { ActiveMenu, ShellNavigationOptions } from '../../lib/app-ui-state'
import {
  CONNECTED_USERNAME_CHANGED_EVENT,
  CONNECTED_USERNAME_STORAGE_KEY,
  readStoredUsername,
  subscribeToUsernameStorage,
  updatePersistedUiState,
} from '../../lib/app-ui-state'
import { supabase } from '../../lib/supabase'

type InterventionsTab = 'interventions' | 'historique'

type InterventionRow = {
  id: number
  date: string
  lieu: string
  appels: number
  debut: string
  fin: string
  commentaire: string
}

type FormErrors = {
  date?: string
  lieu?: string
  appels?: string
  debut?: string
  fin?: string
}

function toHmLabel(value: string) {
  if (!value) return ''
  const match = value.match(/^(\d{2}):(\d{2})/)
  if (!match) return value
  return `${match[1]}:${match[2]}`
}

function computeDuration(startHm: string, endHm: string) {
  const toMinutes = (value: string) => {
    const [hoursText, minutesText] = value.split(':')
    const hours = Number(hoursText)
    const minutes = Number(minutesText)
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
    return hours * 60 + minutes
  }

  const start = toMinutes(startHm)
  const end = toMinutes(endHm)
  if (start === null || end === null || end < start) return '--'

  const total = end - start
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${h} h ${m} min`
}

export default function InterventionsPage() {
  const router = useRouter()
  const connectedUsername = useSyncExternalStore(
    subscribeToUsernameStorage,
    readStoredUsername,
    () => ''
  )

  const [activeMenu, setActiveMenuState] = useState<ActiveMenu>('interventions')
  const [activeDemandesSubMenu, setActiveDemandesSubMenuState] = useState<'nouvelle' | 'voir' | null>(null)
  const [activeConfigurationSubMenu, setActiveConfigurationSubMenuState] = useState<'taches' | null>(null)
  const [activeConfigurationTab, setActiveConfigurationTabState] = useState<'donnees' | 'historique'>('donnees')
  const [connectedUserRole, setConnectedUserRole] = useState<'ADMIN' | 'EMPLOYE'>('EMPLOYE')
  const [connectedUserId, setConnectedUserId] = useState<number | null>(null)
  const [activeInterventionsTab, setActiveInterventionsTab] = useState<InterventionsTab>('interventions')

  const [rows, setRows] = useState<InterventionRow[]>([])
  const [dateFromFilter, setDateFromFilter] = useState('')
  const [dateToFilter, setDateToFilter] = useState('')
  const [rowsLoading, setRowsLoading] = useState(false)
  const [rowsError, setRowsError] = useState('')

  const [showForm, setShowForm] = useState(false)
  const [commentOverlay, setCommentOverlay] = useState<{ x: number; y: number; content: string } | null>(null)
  const [deleteTargetRow, setDeleteTargetRow] = useState<InterventionRow | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [editingRowId, setEditingRowId] = useState<number | null>(null)
  const [submitPending, setSubmitPending] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [formErrors, setFormErrors] = useState<FormErrors>({})

  const [dateIntervention, setDateIntervention] = useState('')
  const [lieuIntervention, setLieuIntervention] = useState('')
  const [nombreAppels, setNombreAppels] = useState(0)
  const [debutIntervention, setDebutIntervention] = useState('')
  const [finIntervention, setFinIntervention] = useState('')
  const [commentaireIntervention, setCommentaireIntervention] = useState('')

  const filteredRows = useMemo(() => {
    if (!dateFromFilter && !dateToFilter) return rows

    const start = dateFromFilter && dateToFilter ? (dateFromFilter <= dateToFilter ? dateFromFilter : dateToFilter) : (dateFromFilter || dateToFilter)
    const end = dateFromFilter && dateToFilter ? (dateFromFilter <= dateToFilter ? dateToFilter : dateFromFilter) : (dateToFilter || dateFromFilter)

    return rows.filter((row) => row.date >= start && row.date <= end)
  }, [rows, dateFromFilter, dateToFilter])

  const resetForm = useCallback(() => {
    setDateIntervention('')
    setLieuIntervention('')
    setNombreAppels(0)
    setDebutIntervention('')
    setFinIntervention('')
    setCommentaireIntervention('')
    setEditingRowId(null)
    setFormErrors({})
    setSubmitError('')
  }, [])

  const loadInterventions = useCallback(async () => {
    setRowsLoading(true)
    setRowsError('')

    const { data, error } = await supabase
      .from('intervention')
      .select(
        'id_intervention, date_intervention, lieu_intervention, nombre_appels_intervention, debut_intervention, fin_intervention, commentaire_intervention'
      )
      .order('date_intervention', { ascending: false })
      .order('debut_intervention', { ascending: false })

    if (error) {
      const errorText = (error.message ?? '').toLowerCase()
      const isNoDataCase =
        errorText.includes('no rows') ||
        errorText.includes('0 rows') ||
        errorText.includes('aucune ligne')

      if (isNoDataCase) {
        setRows([])
        setRowsError('')
        setRowsLoading(false)
        return
      }

      setRows([])
      setRowsError("Impossible de charger les interventions !")
      setRowsLoading(false)
      return
    }

    const nextRows: InterventionRow[] = (data ?? []).map((row: Record<string, unknown>, index) => ({
      id: Number(row.id_intervention) || index + 1,
      date: String(row.date_intervention ?? ''),
      lieu: String(row.lieu_intervention ?? ''),
      appels: Number(row.nombre_appels_intervention ?? 0),
      debut: toHmLabel(String(row.debut_intervention ?? '')),
      fin: toHmLabel(String(row.fin_intervention ?? '')),
      commentaire: String(row.commentaire_intervention ?? ''),
    }))

    setRows(nextRows)
    setRowsLoading(false)
  }, [])

  useEffect(() => {
    updatePersistedUiState((previousState) => ({
      ...previousState,
      activeTab: 'tab1',
      activeMenu: 'interventions',
    }))
    setActiveMenuState('interventions')
  }, [])

  useEffect(() => {
    let cancelled = false

    const syncSession = async () => {
      const response = await fetch('/api/auth/session', { cache: 'no-store' })
      if (!response.ok) {
        if (!cancelled) router.push('/')
        return
      }

      const sessionPayload = (await response.json()) as { role?: string; userId?: number }
      if (!cancelled) {
        setConnectedUserRole(sessionPayload.role === 'ADMIN' ? 'ADMIN' : 'EMPLOYE')
        setConnectedUserId(typeof sessionPayload.userId === 'number' ? sessionPayload.userId : null)
      }
    }

    void syncSession()
    return () => {
      cancelled = true
    }
  }, [router])

  useEffect(() => {
    if (activeInterventionsTab === 'interventions') {
      void loadInterventions()
    }
  }, [activeInterventionsTab, loadInterventions])

  const openAgendaPage = useCallback(() => {
    updatePersistedUiState((previousState) => ({
      ...previousState,
      activeTab: 'tab1',
      activeMenu: 'accueil',
      activeAgendaTab: 'semaine',
    }))
    router.push('/accueil')
  }, [router])

  const openPointagePage = useCallback(() => {
    updatePersistedUiState((previousState) => ({
      ...previousState,
      activeTab: 'tab1',
      activeMenu: 'pointer',
      activePointagesSubMenu: 'nouveau',
    }))
    router.push('/pointage')
  }, [router])

  const openShellPage = useCallback(
    (menu: ActiveMenu, options?: ShellNavigationOptions) => {
      updatePersistedUiState((previousState) => ({
        ...previousState,
        activeTab: 'tab1',
        activeMenu: menu,
        activeDemandesSubMenu:
          options?.demandesSubMenu !== undefined
            ? options.demandesSubMenu
            : previousState.activeDemandesSubMenu,
        activePointagesSubMenu:
          options?.pointagesSubMenu !== undefined
            ? options.pointagesSubMenu
            : previousState.activePointagesSubMenu,
        activeConfigurationSubMenu:
          options?.configurationSubMenu !== undefined
            ? options.configurationSubMenu
            : previousState.activeConfigurationSubMenu,
        activeConfigurationTab:
          options?.configurationTab !== undefined
            ? options.configurationTab
            : previousState.activeConfigurationTab,
      }))

      if (menu === 'accueil') router.push('/accueil')
      else if (menu === 'pointer') router.push('/pointage')
      else if (menu === 'taches') router.push('/taches')
      else if (menu === 'interventions') router.push('/interventions')
      else if (menu === 'gestion_taches') router.push('/gestion-des-activites')
    },
    [router]
  )

  const handleLogout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(CONNECTED_USERNAME_STORAGE_KEY)
      window.dispatchEvent(new Event(CONNECTED_USERNAME_CHANGED_EVENT))
    }
    router.push('/')
  }, [router])

  const validateForm = useCallback(() => {
    const nextErrors: FormErrors = {}
    if (!dateIntervention) nextErrors.date = "Veuillez sélectionner une date !"
    if (!lieuIntervention.trim()) nextErrors.lieu = "Veuillez renseigner le lieu !"
    if (!Number.isFinite(nombreAppels) || nombreAppels < 0) {
      nextErrors.appels = "Le nombre d'appel(s) est invalide !"
    }
    if (!debutIntervention) nextErrors.debut = "Veuillez renseigner l'heure de début !"
    if (!finIntervention) nextErrors.fin = "Veuillez renseigner l'heure de fin !"
    if (debutIntervention && finIntervention && finIntervention <= debutIntervention) {
      nextErrors.fin = "L'heure de fin doit être après l'heure de début !"
    }
    setFormErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }, [dateIntervention, lieuIntervention, nombreAppels, debutIntervention, finIntervention])

  const handleSubmit = useCallback(async () => {
    setSubmitError('')
    if (!validateForm()) return
    if (connectedUserId === null) {
      setSubmitError("Impossible d'identifier l'utilisateur connecté !")
      return
    }

    setSubmitPending(true)
    const payload = {
      id_utilisateur: connectedUserId,
      date_intervention: dateIntervention,
      lieu_intervention: lieuIntervention.trim(),
      nombre_appels_intervention: nombreAppels,
      debut_intervention: debutIntervention,
      fin_intervention: finIntervention,
      commentaire_intervention: commentaireIntervention.trim() || null,
    }

    const { error } =
      editingRowId === null
        ? await supabase.from('intervention').insert(payload)
        : await supabase.from('intervention').update(payload).eq('id_intervention', editingRowId)
    if (error) {
      setSubmitPending(false)
      setSubmitError(error.message || (editingRowId === null ? "Impossible d'ajouter l'intervention !" : "Impossible de modifier l'intervention !"))
      return
    }

    setSubmitPending(false)
    setShowForm(false)
    resetForm()
    await loadInterventions()
  }, [
    validateForm,
    dateIntervention,
    lieuIntervention,
    nombreAppels,
    debutIntervention,
    finIntervention,
    commentaireIntervention,
    connectedUserId,
    editingRowId,
    resetForm,
    loadInterventions,
  ])

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTargetRow) return
    setDeletePending(true)
    setDeleteError('')

    const { error } = await supabase.from('intervention').delete().eq('id_intervention', deleteTargetRow.id)
    if (error) {
      setDeletePending(false)
      setDeleteError(error.message || "Impossible de supprimer l'intervention !")
      return
    }

    setDeletePending(false)
    setDeleteTargetRow(null)
    await loadInterventions()
  }, [deleteTargetRow, loadInterventions])

  const resolvedCommentOverlayStyle = useMemo((): CSSProperties | null => {
    if (!commentOverlay) return null

    const overlayWidth = 560
    const overlayMinHeight = 80
    const margin = 12
    const offset = 14

    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 720

    let left = commentOverlay.x + offset
    let top = commentOverlay.y + offset

    if (left + overlayWidth + margin > viewportWidth) {
      left = Math.max(margin, commentOverlay.x - overlayWidth - offset)
    }

    if (top + overlayMinHeight + margin > viewportHeight) {
      top = Math.max(margin, commentOverlay.y - overlayMinHeight - offset)
    }

    left = Math.max(margin, Math.min(left, viewportWidth - overlayWidth - margin))
    top = Math.max(margin, Math.min(top, viewportHeight - overlayMinHeight - margin))

    return {
      ...commentOverlayStyle,
      left,
      top,
      opacity: 1,
      visibility: 'visible',
    }
  }, [commentOverlay])

  const bodyContent = useMemo(() => {
    if (activeInterventionsTab === 'historique') {
      return <p style={emptyTextStyle}>Aucun historique</p>
    }

    if (showForm) {
      return (
        <div style={overlayStyle}>
          <div style={formCardStyle}>
            <div style={fieldRowStyle}>
              <label style={labelStyle}>Lieu</label>
              <input
                type="text"
                value={lieuIntervention}
                onChange={(e) => setLieuIntervention(e.target.value)}
                style={inputStyle}
                placeholder="Lieu de l'intervention"
              />
              {formErrors.lieu ? <p style={fieldErrorStyle}>{formErrors.lieu}</p> : null}
            </div>
            <div style={dateAppelsRowStyle}>
              <div style={dateAppelsColStyle}>
                <label style={labelStyle}>Date</label>
                <input
                  type="date"
                  value={dateIntervention}
                  onChange={(e) => setDateIntervention(e.target.value)}
                  style={dateTimeInputStyle}
                />
                {formErrors.date ? <p style={fieldErrorStyle}>{formErrors.date}</p> : null}
              </div>
              <div style={dateAppelsColStyle}>
                <label style={labelStyle}>Nombre d&apos;appel(s)</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button type="button" style={counterButtonStyle} onClick={() => setNombreAppels((prev) => Math.max(0, prev - 1))}>
                    -
                  </button>
                  <input
                    type="number"
                    min={0}
                    value={nombreAppels}
                    onChange={(e) => setNombreAppels(Math.max(0, Number(e.target.value || 0)))}
                    style={{ ...centeredInputStyle, width: 96 }}
                  />
                  <button type="button" style={counterButtonStyle} onClick={() => setNombreAppels((prev) => prev + 1)}>
                    +
                  </button>
                </div>
                {formErrors.appels ? <p style={fieldErrorStyle}>{formErrors.appels}</p> : null}
              </div>
            </div>
            <div style={timeRowStyle}>
              <div style={timeColStyle}>
                <label style={labelStyle}>Début</label>
                <input
                  type="time"
                  value={debutIntervention}
                  onChange={(e) => setDebutIntervention(e.target.value)}
                  style={dateTimeInputStyle}
                />
                {formErrors.debut ? <p style={fieldErrorStyle}>{formErrors.debut}</p> : null}
              </div>
              <div style={timeColStyle}>
                <label style={labelStyle}>Fin</label>
                <input
                  type="time"
                  value={finIntervention}
                  onChange={(e) => setFinIntervention(e.target.value)}
                  style={dateTimeInputStyle}
                />
                {formErrors.fin ? <p style={fieldErrorStyle}>{formErrors.fin}</p> : null}
              </div>
            </div>
            <div style={fieldRowStyle}>
              <label style={labelStyle}>Commentaire</label>
              <textarea
                value={commentaireIntervention}
                onChange={(e) => setCommentaireIntervention(e.target.value)}
                style={{ ...inputStyle, minHeight: 86, resize: 'vertical', padding: '10px 14px' }}
              />
            </div>
            {submitError ? <p style={submitErrorStyle}>{submitError}</p> : null}
            <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 17 }}>
              <button
                type="button"
                style={editingRowId === null ? submitButtonStyle : editSubmitButtonStyle}
                onClick={() => void handleSubmit()}
                disabled={submitPending}
              >
                {editingRowId === null ? 'AJOUTER' : 'MODIFIER'}
              </button>
              <button
                type="button"
                style={cancelButtonStyle}
                onClick={() => {
                  setShowForm(false)
                  resetForm()
                }}
                disabled={submitPending}
              >
                ANNULER
              </button>
            </div>
          </div>
        </div>
      )
    }

    if (rowsLoading) return <p style={emptyTextStyle}>Chargement des interventions...</p>
    if (rowsError) return <p style={emptyTextStyle}>{rowsError}</p>
    if (filteredRows.length === 0) return <p style={emptyTextStyle}>Aucune intervention</p>

    return (
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={{ ...thStyle, width: '10%' }}>DATE</th>
            <th style={{ ...thStyle, width: '37%' }}>LIEU</th>
            <th style={{ ...thStyle, width: '10%' }}>APPELS</th>
            <th style={{ ...thStyle, width: '10%' }}>DEBUT</th>
            <th style={{ ...thStyle, width: '10%' }}>FIN</th>
            <th style={{ ...thStyle, width: '12%' }}>DUREE</th>
            <th style={{ ...thStyle, width: '11%' }}>ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          {filteredRows.map((row) => (
            <tr key={row.id}>
              <td style={{ ...tdStyle, width: '10%' }}>{row.date ? new Date(row.date).toLocaleDateString('fr-FR') : '--'}</td>
              <td style={{ ...tdStyle, width: '37%' }}>
                <div style={lieuCellScrollStyle}>{row.lieu || '--'}</div>
              </td>
              <td style={{ ...tdStyle, width: '10%' }}>{row.appels}</td>
              <td style={{ ...tdStyle, width: '10%' }}>{row.debut || '--'}</td>
              <td style={{ ...tdStyle, width: '10%' }}>{row.fin || '--'}</td>
              <td style={{ ...tdStyle, width: '12%' }}>{computeDuration(row.debut, row.fin)}</td>
              <td style={{ ...tdStyle, width: '11%' }}>
                <div style={actionsWrapStyle}>
                  <button
                    type="button"
                    style={actionIconButtonStyle}
                    aria-label="Voir le commentaire"
                    title="Commentaire"
                    onMouseEnter={(event) =>
                      setCommentOverlay({
                        x: event.clientX,
                        y: event.clientY,
                        content: row.commentaire || '',
                      })
                    }
                    onMouseMove={(event) =>
                      setCommentOverlay((previous) =>
                        previous
                          ? { ...previous, x: event.clientX, y: event.clientY }
                          : { x: event.clientX, y: event.clientY, content: row.commentaire || '' }
                      )
                    }
                    onMouseLeave={() => setCommentOverlay(null)}
                  >
                    💬
                  </button>
                  <button
                    type="button"
                    style={actionIconButtonStyle}
                    aria-label="Modifier l'intervention"
                    title="Modifier"
                    onClick={() => {
                      setEditingRowId(row.id)
                      setDateIntervention(row.date || '')
                      setLieuIntervention(row.lieu || '')
                      setNombreAppels(Number.isFinite(row.appels) ? row.appels : 0)
                      setDebutIntervention(row.debut || '')
                      setFinIntervention(row.fin || '')
                      setCommentaireIntervention(row.commentaire || '')
                      setSubmitError('')
                      setFormErrors({})
                      setShowForm(true)
                    }}
                  >
                    ✏️
                  </button>
                  <button
                    type="button"
                    style={actionIconButtonStyle}
                    aria-label="Supprimer l'intervention"
                    title="Supprimer"
                    onClick={() => {
                      setDeleteError('')
                      setDeleteTargetRow(row)
                    }}
                  >
                    ❌
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }, [
    activeInterventionsTab,
    showForm,
    dateIntervention,
    lieuIntervention,
    nombreAppels,
    debutIntervention,
    finIntervention,
    commentaireIntervention,
    formErrors,
    submitError,
    submitPending,
    handleSubmit,
    resetForm,
    rowsLoading,
    rowsError,
    filteredRows,
  ])

  return (
    <AppShell
      connectedUsername={connectedUsername}
      userRole={connectedUserRole}
      activeTab="tab1"
      activeMenu={activeMenu}
      activeDemandesSubMenu={activeDemandesSubMenu}
      activeConfigurationSubMenu={activeConfigurationSubMenu}
      activeConfigurationTab={activeConfigurationTab}
      onTabChange={(tab) => {
        if (tab === 'tab2') router.push('/utilisateurs')
      }}
      onOpenAgenda={openAgendaPage}
      onOpenPointage={openPointagePage}
      onOpenMenu={openShellPage}
      onConfigurationSubMenuChange={setActiveConfigurationSubMenuState}
      onConfigurationTabChange={setActiveConfigurationTabState}
      onLogout={handleLogout}
      middleContent={
        <div style={{ display: 'flex', alignItems: 'flex-end', minHeight: 42 }}>
          <button
            type="button"
            role="tab"
            aria-selected={activeInterventionsTab === 'interventions'}
            onClick={() => setActiveInterventionsTab('interventions')}
            style={{
              minWidth: 150,
              border: 0,
              backgroundColor: activeInterventionsTab === 'interventions' ? '#f5f7fa' : '#e6eaef',
              color: '#2a3342',
              fontFamily: 'Poppins, sans-serif',
              fontSize: '14.3px',
              fontWeight: activeInterventionsTab === 'interventions' ? 600 : 500,
              padding: '0.5rem 0.85rem',
              borderTopLeftRadius: 10,
              borderTopRightRadius: 10,
            }}
          >
            Interventions
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeInterventionsTab === 'historique'}
            onClick={() => setActiveInterventionsTab('historique')}
            style={{
              minWidth: 150,
              border: 0,
              backgroundColor: activeInterventionsTab === 'historique' ? '#f5f7fa' : '#e6eaef',
              color: '#2a3342',
              fontFamily: 'Poppins, sans-serif',
              fontSize: '14.3px',
              fontWeight: activeInterventionsTab === 'historique' ? 600 : 500,
              padding: '0.5rem 0.85rem',
              borderTopLeftRadius: 10,
              borderTopRightRadius: 10,
            }}
          >
            Historique
          </button>
        </div>
      }
    >
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '5px 18px 18px' }}>
        {activeInterventionsTab === 'interventions' ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: '40px' }}>
            {!showForm ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="date"
                  value={dateFromFilter}
                  onChange={(e) => setDateFromFilter(e.target.value)}
                  placeholder="rechercher"
                  style={{ ...dateTimeInputStyle, width: 185 }}
                  aria-label="Date 1"
                />
                <input
                  type="date"
                  value={dateToFilter}
                  onChange={(e) => setDateToFilter(e.target.value)}
                  style={{ ...dateTimeInputStyle, width: 185 }}
                  aria-label="Date 2"
                />
              </div>
            ) : (
              <div />
            )}
            {!showForm ? (
              <button
                type="button"
                style={addButtonStyle}
                onClick={() => {
                  setShowForm(true)
                  setSubmitError('')
                  setFormErrors({})
                }}
              >
                ajouter une intervention
              </button>
            ) : null}
          </div>
        ) : null}
        <div style={{ flex: 1, overflow: 'auto' }}>{bodyContent}</div>
        {commentOverlay && resolvedCommentOverlayStyle ? (
          <div style={resolvedCommentOverlayStyle}>
            {commentOverlay.content}
          </div>
        ) : null}
        {deleteTargetRow ? (
          <div style={overlayStyle}>
            <div style={deleteModalCardStyle}>
              <p style={deleteModalTextStyle}>Voulez-vous vraiment supprimer cette intervention ?</p>
              {deleteError ? <p style={submitErrorStyle}>{deleteError}</p> : null}
              <div style={deleteModalActionsStyle}>
                <button type="button" style={deleteConfirmButtonStyle} onClick={() => void handleConfirmDelete()} disabled={deletePending}>
                  SUPPRIMER
                </button>
                <button
                  type="button"
                  style={cancelButtonStyle}
                  onClick={() => {
                    setDeleteTargetRow(null)
                    setDeleteError('')
                  }}
                  disabled={deletePending}
                >
                  ANNULER
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  )
}

const emptyTextStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'Poppins, sans-serif',
  fontSize: 22,
  fontWeight: 600,
  color: '#4a6381',
  display: 'flex',
  minHeight: 180,
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
}

const addButtonStyle: CSSProperties = {
  height: '36px',
  padding: '0 16px',
  borderRadius: '10px',
  border: '1px solid #8fb3db',
  background: 'linear-gradient(180deg, #ecf3fc 0%, #eff4fc 100%)',
  color: '#1f4f83',
  cursor: 'pointer',
  fontSize: '13.4px',
  fontWeight: 600,
  fontFamily: 'Poppins, sans-serif',
  whiteSpace: 'nowrap',
}

const formCardStyle: CSSProperties = {
  width: '100%',
  maxWidth: 585,
  margin: '0 auto',
  border: '1.5px solid #b7cbe3',
  borderRadius: 12,
  background: '#f5f8fc',
  padding: '26px 16px 28px',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
  boxShadow: '0 10px 24px rgba(24, 43, 66, 0.18)',
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(25, 43, 66, 0.28)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1500,
  padding: 16,
}

const fieldRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const labelStyle: CSSProperties = {
  fontFamily: 'Poppins, sans-serif',
  fontSize: 13,
  fontWeight: 600,
  color: '#2f4f76',
}

const inputStyle: CSSProperties = {
  height: 38,
  border: '1.5px solid #b7cbe3',
  borderRadius: 9,
  background: '#f7fbff',
  color: '#2f4f76',
  fontFamily: 'Poppins, sans-serif',
  fontSize: 14,
  fontWeight: 500,
  padding: '0 14px',
  outline: 'none',
  boxSizing: 'border-box',
  width: '100%',
}

const centeredInputStyle: CSSProperties = {
  ...inputStyle,
  textAlign: 'center',
  padding: '0 10px',
}

const dateTimeInputStyle: CSSProperties = {
  ...centeredInputStyle,
  accentColor: '#1167db',
}

const timeRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 21,
  justifyContent: 'center',
}

const timeColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  width: '75%',
  justifySelf: 'center',
}

const dateAppelsRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 21,
  alignItems: 'start',
  justifyContent: 'center',
}

const dateAppelsColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  width: '75%',
  justifySelf: 'center',
}

const counterButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 8,
  border: '1.5px solid #8fb3db',
  background: '#eef4fc',
  color: '#1f4f83',
  cursor: 'pointer',
  fontFamily: 'Poppins, sans-serif',
  fontWeight: 700,
  fontSize: 14,
  lineHeight: '24px',
  padding: 0,
}

const submitButtonStyle: CSSProperties = {
  height: '36px',
  width: 109,
  padding: '0 12px',
  borderRadius: '11px',
  border: '1.5px solid #72b894',
  background: '#d9f0e1',
  color: '#2f9a67',
  cursor: 'pointer',
  fontSize: '14px',
  fontWeight: 700,
  fontFamily: 'Poppins, sans-serif',
  letterSpacing: '0.02em',
  lineHeight: 1,
  whiteSpace: 'nowrap',
  textTransform: 'uppercase',
}

const cancelButtonStyle: CSSProperties = {
  height: '36px',
  minWidth: 109,
  padding: '0 8px',
  borderRadius: '11px',
  border: '1.5px solid #bcc8d6',
  background: '#e6ebf2',
  color: '#3f628d',
  cursor: 'pointer',
  fontSize: '14px',
  fontWeight: 700,
  fontFamily: 'Poppins, sans-serif',
  letterSpacing: '0.02em',
  lineHeight: 1,
  whiteSpace: 'nowrap',
  textTransform: 'uppercase',
}

const editSubmitButtonStyle: CSSProperties = {
  ...submitButtonStyle,
  border: '1.5px solid #5b93d2',
  background: '#d7e7f8',
  color: '#2f5f96',
}

const submitErrorStyle: CSSProperties = {
  margin: 0,
  color: '#cf2e2e',
  fontFamily: 'Poppins, sans-serif',
  fontSize: 13.5,
  fontWeight: 600,
}

const fieldErrorStyle: CSSProperties = {
  margin: 0,
  color: '#cf2e2e',
  fontFamily: 'Poppins, sans-serif',
  fontSize: 12.5,
  fontWeight: 600,
}

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'separate',
  borderSpacing: 0,
  tableLayout: 'fixed',
  border: '1px solid #c8d6e7',
  borderRadius: 12,
  overflow: 'hidden',
  background: '#f8fafd',
}

const thStyle: CSSProperties = {
  background: '#e5e9ef',
  color: '#2f4f76',
  fontFamily: 'Poppins, sans-serif',
  fontSize: 14.8,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textAlign: 'center',
  padding: '10px 12px',
  borderBottom: '1px solid #c8d6e7',
  borderRight: '1px solid #d3dfec',
}

const tdStyle: CSSProperties = {
  padding: '10px 12px',
  textAlign: 'center',
  borderBottom: '1px solid #d3dfec',
  borderRight: '1px solid #d3dfec',
  color: '#2f4f76',
  fontFamily: 'Poppins, sans-serif',
  fontSize: 14.2,
  fontWeight: 500,
}

const lieuCellScrollStyle: CSSProperties = {
  width: '100%',
  overflowX: 'auto',
  overflowY: 'hidden',
  whiteSpace: 'nowrap',
  textAlign: 'center',
  display: 'block',
}

const commentHoverTriggerStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
}

const commentOverlayStyle: CSSProperties = {
  position: 'fixed',
  minWidth: 340,
  maxWidth: 560,
  minHeight: 38,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid #b7cbe3',
  background: '#f5f8fc',
  color: '#2f4f76',
  fontFamily: 'Poppins, sans-serif',
  fontSize: 13,
  fontWeight: 500,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  textAlign: 'left',
  boxShadow: '0 8px 22px rgba(24, 43, 66, 0.18)',
  pointerEvents: 'none',
  zIndex: 3000,
}

const actionsWrapStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
}

const actionIconButtonStyle: CSSProperties = {
  ...commentHoverTriggerStyle,
  width: 30,
  height: 30,
  borderRadius: 8,
  border: '1px solid #b7cbe3',
  background: '#f5f8fc',
  color: '#2f4f76',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  padding: 0,
  lineHeight: 1,
}

const deleteModalCardStyle: CSSProperties = {
  width: '100%',
  maxWidth: 420,
  border: '1.5px solid #b7cbe3',
  borderRadius: 12,
  background: '#f5f8fc',
  padding: '18px 16px',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  boxShadow: '0 10px 24px rgba(24, 43, 66, 0.18)',
}

const deleteModalTextStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'Poppins, sans-serif',
  fontSize: 14,
  fontWeight: 600,
  color: '#2f4f76',
  textAlign: 'center',
}

const deleteModalActionsStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  gap: 12,
}

const deleteConfirmButtonStyle: CSSProperties = {
  ...submitButtonStyle,
  border: '1.5px solid #d05d5d',
  background: '#f3d4d4',
  color: '#a33a3a',
}
