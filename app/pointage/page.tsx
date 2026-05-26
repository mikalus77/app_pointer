'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { AppShell } from '../../components/app-shell'
import type { ShellNavigationOptions } from '../../lib/app-ui-state'
import { supabase } from '../../lib/supabase'
import styles from './page.module.css'

const UI_STATE_STORAGE_KEY = 'app_pointer_accueil_ui_state'
const CONNECTED_USERNAME_STORAGE_KEY = 'app_pointer_connected_username'
const UI_STATE_CHANGED_EVENT = 'app_pointer_ui_state_changed'
const CONNECTED_USERNAME_CHANGED_EVENT = 'app_pointer_connected_username_changed'
const OTHER_TASK_LABEL = 'Autre tÃ¢che'
const WORK_OFFLINE_GRACE_MINUTES = 5
const PAUSE_AUTO_STOP_MINUTES = 65
const INACTIVITY_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000
const INACTIVITY_RESPONSE_WINDOW_MS = 5 * 60 * 1000
const INACTIVITY_REMINDER_DELAY_MS = 10 * 60 * 1000
const NON_MANUAL_STOP_REASON_CODES = new Set(['ARRET_AUTO', 'INACTIVITE'])
type StopReasonCode = 'ARRET_MANUEL' | 'INACTIVITE' | 'ARRET_AUTO'

type WorkSessionEntry = {
  sessionId: number
  startIso: string
  endIso: string
  durationMs: number
  comment: string | null
  stopReasonCode: StopReasonCode | null
  stopReasonLabel: string | null
}

type WorkEntry = {
  pointageId: number
  taskId: string
  taskTitle: string
  totalDurationMs: number
  sessions: WorkSessionEntry[]
}

type PauseSegmentEntry = {
  pauseId: number
  startIso: string
  endIso: string
  durationMs: number
  comment: string | null
  stopReasonCode: StopReasonCode | null
  stopReasonLabel: string | null
}

type PauseEntry = {
  taskId: string
  taskTitle: string
  totalDurationMs: number
  pauses: PauseSegmentEntry[]
}

type ActiveSessionSnapshot = {
  sessionId: number
  pointageId: number
}

type PointageDaySnapshot = {
  date: Date
  workEntries: WorkEntry[]
  pauseEntries: PauseEntry[]
}

type DayTaskSummary = {
  taskKey: string
  taskId: string
  taskTitle: string
  comment: string
  totalDurationMs: number
}

type DaySummary = {
  dateStamp: string
  totalWorkMs: number
  tasks: DayTaskSummary[]
}

type PointageApiResult<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: string
      unauthorized?: boolean
    }

type ActiveMenu =
  | 'accueil'
  | 'pointer'
  | 'taches'
  | 'demandes'
  | 'suivi_activites'
  | 'gestion_demandes'
  | 'gestion_taches'
  | 'gestion_pointages'
  | 'gestion_bdd'

type PersistedUiState = {
  activeTab: 'tab1' | 'tab2'
  activeMenu: ActiveMenu
  activeAgendaTab: 'semaine' | 'mois'
  activeDemandesSubMenu: 'nouvelle' | 'voir' | null
  activePointagesSubMenu: 'nouveau' | null
  activeConfigurationSubMenu: 'taches' | null
  activeConfigurationTab: 'donnees' | 'historique'
}

const DEFAULT_UI_STATE: PersistedUiState = {
  activeTab: 'tab1',
  activeMenu: 'accueil',
  activeAgendaTab: 'semaine',
  activeDemandesSubMenu: null,
  activePointagesSubMenu: null,
  activeConfigurationSubMenu: null,
  activeConfigurationTab: 'donnees',
}
let cachedUiStateRaw: string | null = null
let cachedUiStateSnapshot: PersistedUiState = DEFAULT_UI_STATE

const WEEKDAY_NAMES = [
  'Lundi',
  'Mardi',
  'Mercredi',
  'Jeudi',
  'Vendredi',
  'Samedi',
  'Dimanche',
]
const LOCAL_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/

function padTimeUnit(value: number) {
  return String(value).padStart(2, '0')
}

function getLocalDateStamp(referenceDate: Date = new Date()) {
  return `${referenceDate.getFullYear()}-${padTimeUnit(referenceDate.getMonth() + 1)}-${padTimeUnit(referenceDate.getDate())}`
}

function getLocalTimestamp(referenceDate: Date = new Date()) {
  return referenceDate.toISOString()
}

function normalizeFreeTaskLabel(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

function buildTaskGroupingKey(taskId: number | string, taskTitle: string) {
  return `${String(taskId)}::${normalizeFreeTaskLabel(taskTitle).toLocaleLowerCase('fr-FR')}`
}

function parseStoredTimestamp(timestamp: string) {
  const normalizedTimestamp = timestamp.trim()
  const postgresTimestampWithTimezone = normalizedTimestamp.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)([zZ]|[+-]\d{2}(?::?\d{2})?)$/
  )
  if (postgresTimestampWithTimezone) {
    const [, datePart, timePart, offsetPart] = postgresTimestampWithTimezone
    const normalizedOffset =
      /[zZ]/.test(offsetPart)
        ? 'Z'
        : offsetPart.includes(':')
          ? offsetPart
          : `${offsetPart.slice(0, 3)}:${offsetPart.slice(3).padEnd(2, '0')}`

    return new Date(`${datePart}T${timePart}${normalizedOffset}`)
  }

  const match = normalizedTimestamp.match(LOCAL_TIMESTAMP_PATTERN)
  if (!match) {
    return new Date(normalizedTimestamp)
  }

  const [, year, month, day, hours, minutes, seconds = '0', fraction = '0'] = match
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hours),
      Number(minutes),
      Number(seconds),
      Number((fraction + '000').slice(0, 3))
    )
  )
}

function getDurationMsBetween(startTimestamp: string, endTimestamp: string) {
  return Math.max(
    parseStoredTimestamp(endTimestamp).getTime() - parseStoredTimestamp(startTimestamp).getTime(),
    0
  )
}

function getWeekFromMonday(referenceDate: Date) {
  const baseDate = new Date(referenceDate)
  baseDate.setHours(0, 0, 0, 0)

  const dayOfWeek = baseDate.getDay()
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek

  const monday = new Date(baseDate)
  monday.setDate(baseDate.getDate() + diffToMonday)

  return Array.from({ length: 7 }, (_, index) => {
    const currentDay = new Date(monday)
    currentDay.setDate(monday.getDate() + index)
    return currentDay
  })
}

function addDays(referenceDate: Date, dayCount: number) {
  const nextDate = new Date(referenceDate)
  nextDate.setDate(referenceDate.getDate() + dayCount)
  return nextDate
}

function addMonths(referenceDate: Date, monthCount: number) {
  const nextDate = new Date(referenceDate)
  nextDate.setMonth(referenceDate.getMonth() + monthCount)
  return nextDate
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate()
}

function isSameCalendarDay(dateA: Date, dateB: Date) {
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  )
}

function getLatestWorkComment(entry: WorkEntry) {
  const latestSession = entry.sessions.at(-1)
  return latestSession?.comment ?? ''
}

function getLatestWorkStopReason(entry: WorkEntry) {
  const latestSession = entry.sessions.at(-1)
  return {
    code: latestSession?.stopReasonCode ?? null,
    label: latestSession?.stopReasonLabel ?? null,
  }
}

function getNonManualStopReasonLabel(
  code: StopReasonCode | null | undefined,
  label: string | null | undefined
) {
  if (!code || !NON_MANUAL_STOP_REASON_CODES.has(code) || !label) {
    return null
  }
  return label.toUpperCase()
}

function buildCommentDisplayParts(
  comment: string | null | undefined,
  stopReasonCode: StopReasonCode | null | undefined,
  stopReasonLabel: string | null | undefined
) {
  const trimmedComment = comment?.trim() ?? ''
  const alertLabel = getNonManualStopReasonLabel(stopReasonCode, stopReasonLabel)

  if (trimmedComment && alertLabel) {
    return { text: trimmedComment, alertLabel, hasContent: true }
  }

  if (trimmedComment) {
    return { text: trimmedComment, alertLabel: null, hasContent: true }
  }

  if (alertLabel) {
    return { text: '', alertLabel, hasContent: true }
  }

  return { text: '-', alertLabel: null, hasContent: false }
}

function summarizeWorkEntries(entries: WorkEntry[]) {
  const summariesByTaskId = new Map<string, DayTaskSummary>()

  for (const entry of entries) {
    const taskKey = buildTaskGroupingKey(entry.taskId, entry.taskTitle)
    const existingSummary = summariesByTaskId.get(taskKey)
    const latestComment = getLatestWorkComment(entry) || '-'

    if (!existingSummary) {
      summariesByTaskId.set(taskKey, {
        taskKey,
        taskId: entry.taskId,
        taskTitle: entry.taskTitle,
        comment: latestComment,
        totalDurationMs: entry.totalDurationMs,
      })
      continue
    }

    const existingComment = existingSummary.comment
    const shouldAppendComment =
      latestComment !== '-' &&
      latestComment !== existingComment &&
      !existingComment.split('-').map((part) => part.trim()).includes(latestComment)

    summariesByTaskId.set(taskKey, {
      ...existingSummary,
      comment:
        latestComment === '-'
          ? existingComment
          : existingComment === '-'
            ? latestComment
            : shouldAppendComment
              ? `${existingComment} - ${latestComment}`
              : existingComment,
      totalDurationMs: existingSummary.totalDurationMs + entry.totalDurationMs,
    })
  }

  const tasks = Array.from(summariesByTaskId.values()).sort((a, b) =>
    a.taskTitle.localeCompare(b.taskTitle)
  )

  return {
    tasks,
    totalWorkMs: tasks.reduce((sum, task) => sum + task.totalDurationMs, 0),
  }
}

function splitCommentLines(comment: string) {
  return comment
    .split(/\s-\s/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function isSystemAutoStopComment(comment: string) {
  const normalizedComment = comment.trim().toLowerCase()
  return (
    normalizedComment.startsWith('session arrêtée automatiquement après') ||
    normalizedComment.startsWith('session arretee automatiquement apres') ||
    normalizedComment.startsWith('pause arrêtée automatiquement après') ||
    normalizedComment.startsWith('pause arretee automatiquement apres')
  )
}

function sanitizeUserComment(comment: string | null | undefined) {
  if (!comment) return null
  return isSystemAutoStopComment(comment) ? null : comment
}

function capitalizeFirstLetter(value: string) {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function readStoredUiState() {
  if (typeof window === 'undefined') {
    return DEFAULT_UI_STATE
  }

  const rawState = window.localStorage.getItem(UI_STATE_STORAGE_KEY)
  if (!rawState) {
    cachedUiStateRaw = null
    cachedUiStateSnapshot = DEFAULT_UI_STATE
    return DEFAULT_UI_STATE
  }

  if (rawState === cachedUiStateRaw) {
    return cachedUiStateSnapshot
  }

  try {
    const parsedState = JSON.parse(rawState) as Partial<PersistedUiState>
    const nextSnapshot = {
      activeTab: parsedState.activeTab ?? DEFAULT_UI_STATE.activeTab,
      activeMenu: parsedState.activeMenu ?? DEFAULT_UI_STATE.activeMenu,
      activeAgendaTab: parsedState.activeAgendaTab ?? DEFAULT_UI_STATE.activeAgendaTab,
      activeDemandesSubMenu:
        parsedState.activeDemandesSubMenu ?? DEFAULT_UI_STATE.activeDemandesSubMenu,
      activePointagesSubMenu:
        parsedState.activePointagesSubMenu ?? DEFAULT_UI_STATE.activePointagesSubMenu,
      activeConfigurationSubMenu:
        parsedState.activeConfigurationSubMenu ?? DEFAULT_UI_STATE.activeConfigurationSubMenu,
      activeConfigurationTab:
        parsedState.activeConfigurationTab ?? DEFAULT_UI_STATE.activeConfigurationTab,
    }
    cachedUiStateRaw = rawState
    cachedUiStateSnapshot = nextSnapshot
    return nextSnapshot
  } catch {
    cachedUiStateRaw = null
    cachedUiStateSnapshot = DEFAULT_UI_STATE
    return DEFAULT_UI_STATE
  }
}

function subscribeToUiStateStorage(onStoreChange: () => void) {
  if (typeof window === 'undefined') {
    return () => {}
  }

  const handleStorage = (event: StorageEvent) => {
    if (!event.key || event.key === UI_STATE_STORAGE_KEY) {
      onStoreChange()
    }
  }

  const handleLocalEvent = () => {
    onStoreChange()
  }

  window.addEventListener('storage', handleStorage)
  window.addEventListener(UI_STATE_CHANGED_EVENT, handleLocalEvent)
  return () => {
    window.removeEventListener('storage', handleStorage)
    window.removeEventListener(UI_STATE_CHANGED_EVENT, handleLocalEvent)
  }
}

function readStoredUsername() {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.localStorage.getItem(CONNECTED_USERNAME_STORAGE_KEY) ?? ''
}

function subscribeToUsernameStorage(onStoreChange: () => void) {
  if (typeof window === 'undefined') {
    return () => {}
  }

  const handleStorage = (event: StorageEvent) => {
    if (!event.key || event.key === CONNECTED_USERNAME_STORAGE_KEY) {
      onStoreChange()
    }
  }

  const handleLocalEvent = () => {
    onStoreChange()
  }

  window.addEventListener('storage', handleStorage)
  window.addEventListener(CONNECTED_USERNAME_CHANGED_EVENT, handleLocalEvent)
  return () => {
    window.removeEventListener('storage', handleStorage)
    window.removeEventListener(CONNECTED_USERNAME_CHANGED_EVENT, handleLocalEvent)
  }
}

export default function AccueilPage() {
  const router = useRouter()
  const uiState = useSyncExternalStore(
    subscribeToUiStateStorage,
    readStoredUiState,
    () => DEFAULT_UI_STATE
  )
  const {
    activeTab,
    activeMenu,
    activeAgendaTab,
    activeDemandesSubMenu,
    activePointagesSubMenu,
    activeConfigurationSubMenu,
    activeConfigurationTab,
  } = uiState

  useEffect(() => {
    if (activeTab === 'tab2') {
      router.replace('/utilisateurs')
    }
  }, [activeTab, router])
  const [taskOptions, setTaskOptions] = useState<Array<{ id: string; title: string }>>([])
  const [taskChoice, setTaskChoice] = useState('')
  const [otherTaskOptionId, setOtherTaskOptionId] = useState<string | null>(null)
  const [otherTaskLabel, setOtherTaskLabel] = useState('')
  const [taskLoading, setTaskLoading] = useState(false)
  const [taskLoadError, setTaskLoadError] = useState('')
  const [pointageComment, setPointageComment] = useState('')
  const [pauseComment, setPauseComment] = useState('')
  const [pointageStopError, setPointageStopError] = useState('')
  const [pointageMode, setPointageMode] = useState<'idle' | 'running' | 'paused'>('idle')
  const [workElapsedMs, setWorkElapsedMs] = useState(0)
  const [pauseElapsedMs, setPauseElapsedMs] = useState(0)
  const [monthDetailDate, setMonthDetailDate] = useState<Date | null>(null)
  const [pointageValidationPreviewDate, setPointageValidationPreviewDate] = useState<Date | null>(
    null
  )
  const [pointageDayView, setPointageDayView] = useState<'today' | 'yesterday'>('today')
  const [isYesterdayAutoValidated, setIsYesterdayAutoValidated] = useState(false)
  const [yesterdayPointageSnapshot, setYesterdayPointageSnapshot] =
    useState<PointageDaySnapshot | null>(null)
  const [connectedUserId, setConnectedUserId] = useState<number | null>(null)
  const [connectedUserRole, setConnectedUserRole] = useState<'ADMIN' | 'EMPLOYE'>('EMPLOYE')
  const [expectedDailyDurationMs, setExpectedDailyDurationMs] = useState<number | null>(null)
  const [currentPointageId, setCurrentPointageId] = useState<number | null>(null)
  const [currentSessionPointageId, setCurrentSessionPointageId] = useState<number | null>(null)
  const [currentPausePointageId, setCurrentPausePointageId] = useState<number | null>(null)
  const [currentPauseStartedAtIso, setCurrentPauseStartedAtIso] = useState<string | null>(null)
  const [currentWorkEntryId, setCurrentWorkEntryId] = useState<number | null>(null)
  const [currentSessionBaseElapsedMs, setCurrentSessionBaseElapsedMs] = useState(0)
  const [currentSessionPauseTotalMs, setCurrentSessionPauseTotalMs] = useState(0)
  const [currentSessionStartedAtIso, setCurrentSessionStartedAtIso] = useState<string | null>(null)
  const [workEntries, setWorkEntries] = useState<WorkEntry[]>([])
  const [pauseEntries, setPauseEntries] = useState<PauseEntry[]>([])
  const [agendaDaySummaries, setAgendaDaySummaries] = useState<Record<string, DaySummary>>({})
  const [pointageMutationPending, setPointageMutationPending] = useState(false)
  const [pointageRefreshKey, setPointageRefreshKey] = useState(0)
  const [showInactivityPrompt, setShowInactivityPrompt] = useState(false)
  const stopErrorTimeoutRef = useRef<number | null>(null)
  const midnightTransitionPendingRef = useRef(false)
  const serverClockAnchorRef = useRef<{ serverMs: number; perfMs: number } | null>(null)
  const statusIdCacheRef = useRef<Record<string, number | undefined>>({})
  const inactivityPromptShownAtRef = useRef<number | null>(null)
  const inactivityStopInProgressRef = useRef(false)
  const inactivityLastCheckResponseAtRef = useRef<number | null>(null)
  const inactivityReminderSentRef = useRef(false)
  const inactivityNotificationRef = useRef<Notification | null>(null)
  const pointageCommentRef = useRef(pointageComment)
  const pauseCommentRef = useRef(pauseComment)
  const pointageModeRef = useRef(pointageMode)
  const currentSessionPointageIdRef = useRef(currentSessionPointageId)
  const connectedUsername = useSyncExternalStore(
    subscribeToUsernameStorage,
    readStoredUsername,
    () => ''
  )

  useEffect(() => {
    let cancelled = false

    const syncSession = async () => {
      try {
        const response = await fetch('/api/auth/session', { cache: 'no-store' })

        if (!response.ok) {
          if (typeof window !== 'undefined') {
            window.localStorage.removeItem(CONNECTED_USERNAME_STORAGE_KEY)
            window.dispatchEvent(new Event(CONNECTED_USERNAME_CHANGED_EVENT))
          }

          if (!cancelled) {
            router.replace('/')
          }
          return
        }

        const sessionPayload = (await response.json()) as {
          userId?: number
          username?: string
          role?: string
        }

        if (cancelled) {
          return
        }

        if (typeof sessionPayload.userId === 'number') {
          setConnectedUserId(sessionPayload.userId)
        }
        setConnectedUserRole(sessionPayload.role === 'ADMIN' ? 'ADMIN' : 'EMPLOYE')

        if (typeof window !== 'undefined' && typeof sessionPayload.username === 'string') {
          if (window.localStorage.getItem(CONNECTED_USERNAME_STORAGE_KEY) !== sessionPayload.username) {
            window.localStorage.setItem(CONNECTED_USERNAME_STORAGE_KEY, sessionPayload.username)
            window.dispatchEvent(new Event(CONNECTED_USERNAME_CHANGED_EVENT))
          }
        }
      } catch {
        if (!cancelled) {
          router.replace('/')
        }
      }
    }

    void syncSession()

    return () => {
      cancelled = true
    }
  }, [router])

  useEffect(() => {
    if (connectedUserId === null) {
      setExpectedDailyDurationMs(null)
      return
    }

    let cancelled = false

    const loadExpectedDuration = async () => {
      const { data, error } = await supabase
        .from('utilisateur')
        .select('duree_journaliere_attendue_utilisateur')
        .eq('id_utilisateur', connectedUserId)
        .single()

      if (cancelled) {
        return
      }

      if (error || !data) {
        setExpectedDailyDurationMs(null)
        return
      }

      const expectedDailyMinutes = Number(data.duree_journaliere_attendue_utilisateur)
      if (!Number.isFinite(expectedDailyMinutes) || expectedDailyMinutes < 0) {
        setExpectedDailyDurationMs(null)
        return
      }

      setExpectedDailyDurationMs(expectedDailyMinutes * 60 * 1000)
    }

    void loadExpectedDuration()

    return () => {
      cancelled = true
    }
  }, [connectedUserId])

  const postPointageApi = useCallback(
    async <T,>(path: string, body?: Record<string, unknown>): Promise<PointageApiResult<T>> => {
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body ?? {}),
        })

        const payload = (await response.clone().json().catch(() => null)) as
          | { error?: string }
          | T
          | null

        if (!response.ok) {
          if (response.status === 401) {
            if (typeof window !== 'undefined') {
              window.localStorage.removeItem(CONNECTED_USERNAME_STORAGE_KEY)
              window.dispatchEvent(new Event(CONNECTED_USERNAME_CHANGED_EVENT))
            }
            router.replace('/')
            return {
              ok: false,
              error: 'Session expirÃ©e.',
              unauthorized: true,
            }
          }

          return {
            ok: false,
            error:
              payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
                ? payload.error
                : `Erreur HTTP ${response.status}: ${(await response.text().catch(() => '')).trim() || 'réponse vide'}`,
          }
        }

        return {
          ok: true,
          data: payload as T,
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Une erreur est survenue.'
        return {
          ok: false,
          error: errorMessage || 'Une erreur est survenue.',
        }
      }
    },
    [router]
  )

  const updateServerClockAnchor = (serverNowMs: number) => {
    serverClockAnchorRef.current = {
      serverMs: serverNowMs,
      perfMs: performance.now(),
    }
  }

  const getEstimatedServerNowMs = useCallback(() => {
    const anchor = serverClockAnchorRef.current
    if (!anchor) {
      return Date.now()
    }
    return anchor.serverMs + (performance.now() - anchor.perfMs)
  }, [])

  const getEstimatedServerNowDate = useCallback(
    () => new Date(getEstimatedServerNowMs()),
    [getEstimatedServerNowMs]
  )

  const getEstimatedServerDateStamp = useCallback(
    () => getLocalDateStamp(getEstimatedServerNowDate()),
    [getEstimatedServerNowDate]
  )

  const syncServerClock = useCallback(async () => {
    try {
      const response = await fetch('/api/server-time', { cache: 'no-store' })
      if (!response.ok) {
        return false
      }
      const payload = (await response.json()) as { nowMs?: number }
      if (typeof payload.nowMs === 'number' && Number.isFinite(payload.nowMs)) {
        updateServerClockAnchor(payload.nowMs)
        return true
      }
      return false
    } catch {
      // Keep existing anchor if sync fails.
      return false
    }
  }, [])

  const playInactivityTone = useCallback(() => {
    try {
      const AudioContextClass =
        typeof window !== 'undefined'
          ? (window.AudioContext ||
              (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
          : null

      if (!AudioContextClass) {
        return
      }

      const audioContext = new AudioContextClass()
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = 880
      gainNode.gain.setValueAtTime(0.0001, audioContext.currentTime)
      gainNode.gain.exponentialRampToValueAtTime(0.08, audioContext.currentTime + 0.02)
      gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.22)
      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)
      oscillator.start()
      oscillator.stop(audioContext.currentTime + 0.24)
      window.setTimeout(() => {
        void audioContext.close()
      }, 320)
    } catch {
      // Ignore sound errors silently.
    }
  }, [])

  const closeInactivityNotification = useCallback(() => {
    if (inactivityNotificationRef.current) {
      inactivityNotificationRef.current.close()
      inactivityNotificationRef.current = null
    }
  }, [])

  const notifyInactivity = useCallback(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return
    }

    if (Notification.permission !== 'granted') {
      return
    }

    closeInactivityNotification()
    const notification = new Notification('Jarvis Time', {
      body: `Toujours en activité${connectedUsername ? ` ${connectedUsername}` : ''} ? Le pointage va s'arrêter automatiquement.`,
      tag: 'pointage-inactivite',
      renotify: true,
      requireInteraction: true,
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
    inactivityNotificationRef.current = notification
  }, [closeInactivityNotification, connectedUsername])

  const ensureNotificationPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return
    }

    if (Notification.permission === 'default') {
      try {
        await Notification.requestPermission()
      } catch {
        // Ignore notification permission errors.
      }
    }
  }, [])

  const getStatusIdByCode = useCallback(async (statusCode: string) => {
    const cachedStatusId = statusIdCacheRef.current[statusCode]
    if (typeof cachedStatusId === 'number') {
      return cachedStatusId
    }

    const { data: statusData, error: statusError } = await supabase
      .from('statut_pointage')
      .select('id_statut_pointage')
      .eq('code_statut_pointage', statusCode)
      .eq('actif', true)
      .single()

    if (statusError || !statusData) {
      return null
    }

    statusIdCacheRef.current[statusCode] = statusData.id_statut_pointage
    return statusData.id_statut_pointage
  }, [])

  const getResolvedTaskTitle = useCallback(
    (fallbackTaskTitle: string | undefined, freeTaskLabel?: string | null) => {
      const normalizedFreeTaskLabel = normalizeFreeTaskLabel(freeTaskLabel ?? '')
      return normalizedFreeTaskLabel || fallbackTaskTitle || 'TÃ¢che non renseignÃ©e'
    },
    []
  )

  const applyAutoClosureForUser = useCallback(async () => {
    const result = await postPointageApi<{
      rows: Array<{ closed_session_id?: number | null; closed_pause_id?: number | null }>
    }>('/api/pointage/auto-closure', {
      workGraceMinutes: WORK_OFFLINE_GRACE_MINUTES,
      pauseMaxMinutes: PAUSE_AUTO_STOP_MINUTES,
    })

    if (!result.ok) {
      return false
    }

    const rows = Array.isArray(result.data.rows) ? result.data.rows : []
    return rows.some(
      (row) =>
        typeof row?.closed_session_id === 'number' || typeof row?.closed_pause_id === 'number'
    )
  }, [postPointageApi])

  const sendPointageHeartbeat = useCallback(async () => {
    if (pointageMode === 'idle') {
      return
    }

    await postPointageApi('/api/pointage/heartbeat')
  }, [pointageMode, postPointageApi])

  const autoValidateDayIfNoActiveSession = useCallback(
    async (userId: number, targetDateStamp: string) => {
      const enCoursStatusId = await getStatusIdByCode('EN_COURS')
      if (enCoursStatusId === null) {
        return false
      }

      const { data: pendingPointages, error: pendingPointagesError } = await supabase
        .from('pointage')
        .select('id_pointage')
        .eq('id_utilisateur_pointeur', userId)
        .eq('date_pointage', targetDateStamp)
        .eq('id_statut_pointage', enCoursStatusId)
        .limit(1)

      if (pendingPointagesError || !pendingPointages || pendingPointages.length === 0) {
        return false
      }

      const { data: userPointages, error: userPointagesError } = await supabase
        .from('pointage')
        .select('id_pointage')
        .eq('id_utilisateur_pointeur', userId)

      if (userPointagesError || !userPointages || userPointages.length === 0) {
        return false
      }

      const pointageIds = userPointages.map((row) => row.id_pointage)
      const { data: activeSessions, error: activeSessionsError } = await supabase
        .from('session_pointage')
        .select('id_session_pointage')
        .in('id_pointage', pointageIds)
        .is('fin_session_pointage', null)
        .limit(1)

      if (activeSessionsError) {
        return false
      }

      // Keep the explicit Hier / Aujourd'hui split only when a chrono is still active.
      if (activeSessions && activeSessions.length > 0) {
        return false
      }

      const validationResult = await postPointageApi<{ validatedCount: number }>(
        '/api/pointage/validate',
        {
          pointageDate: targetDateStamp,
        }
      )

      return validationResult.ok && validationResult.data.validatedCount > 0
    },
    [getStatusIdByCode, postPointageApi]
  )

  const autoValidatePendingDaysBefore = useCallback(
    async (userId: number, beforeDateStamp: string) => {
      const enCoursStatusId = await getStatusIdByCode('EN_COURS')
      if (enCoursStatusId === null) {
        return false
      }

      const { data: pendingRows, error: pendingRowsError } = await supabase
        .from('pointage')
        .select('date_pointage')
        .eq('id_utilisateur_pointeur', userId)
        .eq('id_statut_pointage', enCoursStatusId)
        .lt('date_pointage', beforeDateStamp)
        .order('date_pointage', { ascending: true })

      if (pendingRowsError || !pendingRows || pendingRows.length === 0) {
        return false
      }

      const uniqueDateStamps = Array.from(new Set(pendingRows.map((row) => row.date_pointage)))
      let didValidateAtLeastOneDay = false

      for (const dateStamp of uniqueDateStamps) {
        const validationResult = await postPointageApi<{ validatedCount: number }>(
          '/api/pointage/validate',
          {
            pointageDate: dateStamp,
          }
        )

        if (validationResult.ok && validationResult.data.validatedCount > 0) {
          didValidateAtLeastOneDay = true
        }
      }

      return didValidateAtLeastOneDay
    },
    [getStatusIdByCode, postPointageApi]
  )

  useEffect(() => {
    pointageCommentRef.current = pointageComment
  }, [pointageComment])

  useEffect(() => {
    if (otherTaskOptionId !== null && taskChoice === otherTaskOptionId) {
      return
    }
    if (pointageMode === 'idle') {
      setOtherTaskLabel('')
    }
  }, [otherTaskOptionId, pointageMode, taskChoice])

  useEffect(() => {
    pauseCommentRef.current = pauseComment
  }, [pauseComment])

  useEffect(() => {
    pointageModeRef.current = pointageMode
  }, [pointageMode])

  useEffect(() => {
    currentSessionPointageIdRef.current = currentSessionPointageId
  }, [currentSessionPointageId])

  useEffect(() => {
    void syncServerClock()
  }, [syncServerClock])

  useEffect(() => {
    if (pointageMode === 'idle') {
      return
    }

    const runPeriodicPointageSync = () => {
      void (async () => {
        await syncServerClock()
        if (connectedUserId) {
          const didAutoClose = await applyAutoClosureForUser()
          if (didAutoClose) {
            setPointageRefreshKey((previousKey) => previousKey + 1)
          } else {
            await sendPointageHeartbeat()
          }
        }
      })()
    }

    runPeriodicPointageSync()
    const timer = window.setInterval(runPeriodicPointageSync, 30000)

    return () => window.clearInterval(timer)
  }, [applyAutoClosureForUser, connectedUserId, pointageMode, sendPointageHeartbeat, syncServerClock])

  const updatePersistedUiState = (
    updater: (previousState: PersistedUiState) => PersistedUiState
  ) => {
    if (typeof window === 'undefined') {
      return
    }

    const nextState = updater(readStoredUiState())
    window.localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(nextState))
    window.dispatchEvent(new Event(UI_STATE_CHANGED_EVENT))
  }

  const setActiveTab = (value: 'tab1' | 'tab2') =>
    updatePersistedUiState((previousState) => ({ ...previousState, activeTab: value }))
  const setActiveMenu = (value: ActiveMenu) =>
    updatePersistedUiState((previousState) => ({ ...previousState, activeMenu: value }))
  const setActiveAgendaTab = (value: 'semaine' | 'mois') =>
    updatePersistedUiState((previousState) => ({ ...previousState, activeAgendaTab: value }))
  const setActiveDemandesSubMenu = (value: 'nouvelle' | 'voir' | null) =>
    updatePersistedUiState((previousState) => ({
      ...previousState,
      activeDemandesSubMenu: value,
    }))
  const setActivePointagesSubMenu = (value: 'nouveau' | null) =>
    updatePersistedUiState((previousState) => ({
      ...previousState,
      activePointagesSubMenu: value,
    }))
  const setActiveConfigurationSubMenu = (value: 'taches' | null) =>
    updatePersistedUiState((previousState) => ({
      ...previousState,
      activeConfigurationSubMenu: value,
    }))
  const setActiveConfigurationTab = (value: 'donnees' | 'historique') =>
    updatePersistedUiState((previousState) => ({
      ...previousState,
      activeConfigurationTab: value,
    }))

  const openAgendaPage = (agendaTab?: 'semaine' | 'mois') => {
    setActiveTab('tab1')
    setActiveMenu('accueil')
    if (agendaTab) {
      setActiveAgendaTab(agendaTab)
    }
    router.push('/accueil')
  }

  const openPointagePage = () => {
    setActiveTab('tab1')
    setActiveMenu('pointer')
    setActivePointagesSubMenu('nouveau')
    router.push('/pointage')
  }

  const openShellPage = (menu: ActiveMenu, options?: ShellNavigationOptions) => {
    setActiveTab('tab1')
    setActiveMenu(menu)
    if (options?.demandesSubMenu !== undefined) {
      setActiveDemandesSubMenu(options.demandesSubMenu)
    }
    if (options?.configurationSubMenu !== undefined) {
      setActiveConfigurationSubMenu(options.configurationSubMenu)
    }
    if (options?.configurationTab !== undefined) {
      setActiveConfigurationTab(options.configurationTab)
    }
    if (menu === 'gestion_taches') {
      router.push('/gestion-des-activites')
      return
    }
    if (menu === 'taches') {
      router.push('/taches')
      return
    }
    router.push('/accueil')
  }

  useEffect(() => {
    setActiveTab('tab1')
    setActiveMenu('pointer')
    setActivePointagesSubMenu('nouveau')
  }, [])

  const todayAtLoad = useMemo(() => new Date(), [])
  const currentWeekMonday = useMemo(() => getWeekFromMonday(todayAtLoad)[0], [todayAtLoad])
  const [selectedDay, setSelectedDay] = useState(todayAtLoad.getDate())
  const [selectedMonth, setSelectedMonth] = useState(todayAtLoad.getMonth() + 1)
  const [selectedYear, setSelectedYear] = useState(todayAtLoad.getFullYear())

  const maxSelectableYear = todayAtLoad.getFullYear() + 1
  const yearOptions = useMemo(() => {
    const firstYear = 2026
    const years: number[] = []
    for (let year = firstYear; year <= maxSelectableYear; year += 1) {
      years.push(year)
    }
    return years
  }, [maxSelectableYear])

  const daysInSelectedMonth = useMemo(
    () => getDaysInMonth(selectedYear, selectedMonth),
    [selectedYear, selectedMonth]
  )

  const handleSelectedDayChange = (day: number) => {
    setSelectedDay(day)
  }

  const handleSelectedMonthChange = (month: number) => {
    setSelectedMonth(month)
    setSelectedDay((previousDay) => Math.min(previousDay, getDaysInMonth(selectedYear, month)))
  }

  const handleSelectedYearChange = (year: number) => {
    setSelectedYear(year)
    setSelectedDay((previousDay) => Math.min(previousDay, getDaysInMonth(year, selectedMonth)))
  }

  useEffect(() => {
    const isPointageViewActive = activeMenu === 'pointer' && activePointagesSubMenu === 'nouveau'
    const shouldRefreshTasks = isPointageViewActive && pointageMode === 'idle'

    const loadUserTasks = async () => {
      if (!connectedUsername || !shouldRefreshTasks) {
        if (!connectedUsername) {
          setConnectedUserId(null)
          setOtherTaskOptionId(null)
        }
        return
      }

      setTaskLoading(true)
      setTaskLoadError('')

      const { data: userData, error: userError } = await supabase
        .from('utilisateur')
        .select('id_utilisateur, id_statut_utilisateur!inner(code_statut_utilisateur)')
        .eq('username_utilisateur', connectedUsername)
        .eq('id_statut_utilisateur.code_statut_utilisateur', 'ACTIVE')
        .single()

      if (userError || !userData) {
        setConnectedUserId(null)
        setOtherTaskOptionId(null)
        setTaskOptions([])
        setTaskChoice('')
        setTaskLoadError('Impossible de charger les tÃ¢ches.')
        setTaskLoading(false)
        return
      }

      setConnectedUserId(userData.id_utilisateur)

      const { data: assignedTasksData, error: assignedTasksError } = await supabase
        .from('utilisateur_tache')
        .select('id_tache')
        .eq('id_utilisateur', userData.id_utilisateur)

      if (assignedTasksError || !assignedTasksData) {
        setTaskOptions([])
        setTaskChoice('')
        setTaskLoadError('Impossible de charger les tÃ¢ches.')
        setTaskLoading(false)
        return
      }

      const taskIds = assignedTasksData.map((taskLink) => taskLink.id_tache)

      if (taskIds.length === 0) {
        setOtherTaskOptionId(null)
        setTaskOptions([])
        setTaskChoice('')
        setTaskLoadError('Aucune tÃ¢che attribuÃ©e.')
        setTaskLoading(false)
        return
      }

      const { data: tasksData, error: tasksError } = await supabase
        .from('tache')
        .select('id_tache, titre_tache, tache_systeme')
        .in('id_tache', taskIds)
        .eq('actif', true)
        .order('titre_tache', { ascending: true })

      if (tasksError || !tasksData) {
        setOtherTaskOptionId(null)
        setTaskOptions([])
        setTaskChoice('')
        setTaskLoadError('Impossible de charger les tÃ¢ches.')
        setTaskLoading(false)
        return
      }

      const systemTaskData = tasksData.find((task) => task.tache_systeme)
      if (!systemTaskData) {
        setOtherTaskOptionId(null)
        setTaskOptions([])
        setTaskChoice('')
        setTaskLoadError('La tÃ¢che systÃ¨me "Autre tÃ¢che" est introuvable.')
        setTaskLoading(false)
        return
      }

      setOtherTaskOptionId(String(systemTaskData.id_tache))

      const nextTaskOptions = tasksData.map((task) => ({
        id: String(task.id_tache),
        title: task.tache_systeme ? task.titre_tache || OTHER_TASK_LABEL : task.titre_tache,
      }))

      setTaskOptions(nextTaskOptions)
      setTaskChoice((previousChoice) =>
        nextTaskOptions.some((task) => task.id === previousChoice)
          ? previousChoice
          : nextTaskOptions[0]?.id ?? ''
      )
      setTaskLoading(false)
    }

    void loadUserTasks()
  }, [activeMenu, activePointagesSubMenu, connectedUsername, pointageMode])

  useEffect(() => {
    return () => {
      if (stopErrorTimeoutRef.current !== null) {
        window.clearTimeout(stopErrorTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const isPointageViewActive = activeMenu === 'pointer' && activePointagesSubMenu === 'nouveau'
    if (!isPointageViewActive || !connectedUsername) {
      return
    }

    let cancelled = false

    const restorePointageState = async () => {
      await syncServerClock()
      const pointageDate = getEstimatedServerDateStamp()
      const todayRef = getEstimatedServerNowDate()
      const yesterdayRef = new Date(todayRef)
      yesterdayRef.setDate(yesterdayRef.getDate() - 1)
      yesterdayRef.setHours(0, 0, 0, 0)
      const yesterdayDateStamp = getLocalDateStamp(yesterdayRef)
      const { data: userData, error: userError } = await supabase
        .from('utilisateur')
        .select('id_utilisateur, id_statut_utilisateur!inner(code_statut_utilisateur)')
        .eq('username_utilisateur', connectedUsername)
        .eq('id_statut_utilisateur.code_statut_utilisateur', 'ACTIVE')
        .single()

      if (cancelled || userError || !userData) {
        return
      }

      const userId = userData.id_utilisateur
      setConnectedUserId(userId)
      await applyAutoClosureForUser()
      const enCoursStatusId = await getStatusIdByCode('EN_COURS')
      const termineStatusId = await getStatusIdByCode('TERMINE')

      if (cancelled || enCoursStatusId === null || termineStatusId === null) {
        return
      }

      await autoValidatePendingDaysBefore(userId, yesterdayDateStamp)

      const didAutoValidateYesterday = await autoValidateDayIfNoActiveSession(
        userId,
        yesterdayDateStamp
      )

      if (cancelled) {
        return
      }

      const buildDaySnapshot = async (targetDateStamp: string, targetDate: Date) => {
        const { data: dayPointageRows, error: dayPointageError } = await supabase
          .from('pointage')
          .select('id_pointage, id_tache, libelle_tache_libre_pointage')
          .eq('id_utilisateur_pointeur', userId)
          .eq('date_pointage', targetDateStamp)
          .eq('id_statut_pointage', enCoursStatusId)
          .order('id_pointage', { ascending: true })

        if (dayPointageError || !dayPointageRows || dayPointageRows.length === 0) {
          return null
        }

        const dayPointageIds = dayPointageRows.map((row) => row.id_pointage)
        const dayTaskIds = Array.from(new Set(dayPointageRows.map((row) => row.id_tache)))

        const [{ data: dayTaskRows }, { data: daySessionRows, error: daySessionError }] =
          await Promise.all([
            supabase.from('tache').select('id_tache, titre_tache').in('id_tache', dayTaskIds),
            supabase
              .from('session_pointage')
              .select(
                'id_session_pointage, id_pointage, debut_session_pointage, fin_session_pointage, commentaire_session_pointage, motif_arret_session:motif_arret_session!fk_session_pointage_motif_arret_session(code_motif_arret_session, libelle_motif_arret_session)'
              )
              .in('id_pointage', dayPointageIds)
              .order('debut_session_pointage', { ascending: true }),
          ])

        if (daySessionError || !daySessionRows) {
          return null
        }

        const dayTaskTitleById = new Map<number, string>(
          (dayTaskRows ?? []).map((task) => [task.id_tache, task.titre_tache])
        )
        const dayPointageMetaById = new Map<number, { taskId: number; taskTitle: string }>(
          dayPointageRows.map((row) => [
            row.id_pointage,
            {
              taskId: row.id_tache,
              taskTitle: getResolvedTaskTitle(
                dayTaskTitleById.get(row.id_tache),
                row.libelle_tache_libre_pointage
              ),
            },
          ])
        )
        const dayPointageToCanonicalByTask = new Map<string, number>()
        for (const row of dayPointageRows) {
          const taskTitle = getResolvedTaskTitle(
            dayTaskTitleById.get(row.id_tache),
            row.libelle_tache_libre_pointage
          )
          const taskGroupingKey = buildTaskGroupingKey(row.id_tache, taskTitle)
          if (!dayPointageToCanonicalByTask.has(taskGroupingKey)) {
            dayPointageToCanonicalByTask.set(taskGroupingKey, row.id_pointage)
          }
        }

        const dayWorkByTaskId = new Map<string, WorkEntry>()
        for (const session of daySessionRows) {
          const taskMeta = dayPointageMetaById.get(session.id_pointage)
          if (!taskMeta || !session.fin_session_pointage) {
            continue
          }

          const taskGroupingKey = buildTaskGroupingKey(taskMeta.taskId, taskMeta.taskTitle)
          const canonicalPointageId =
            dayPointageToCanonicalByTask.get(taskGroupingKey) ?? session.id_pointage
          if (!dayWorkByTaskId.has(taskGroupingKey)) {
            dayWorkByTaskId.set(taskGroupingKey, {
              pointageId: canonicalPointageId,
              taskId: String(taskMeta.taskId),
              taskTitle: taskMeta.taskTitle,
              totalDurationMs: 0,
              sessions: [],
            })
          }

          const durationMs = getDurationMsBetween(
            session.debut_session_pointage,
            session.fin_session_pointage
          )
          const entry = dayWorkByTaskId.get(taskGroupingKey) as WorkEntry
          entry.sessions.push({
            sessionId: session.id_session_pointage,
            startIso: session.debut_session_pointage,
            endIso: session.fin_session_pointage,
            durationMs,
            comment: sanitizeUserComment(session.commentaire_session_pointage),
            stopReasonCode: session.motif_arret_session?.code_motif_arret_session ?? null,
            stopReasonLabel: session.motif_arret_session?.libelle_motif_arret_session ?? null,
          })
          entry.totalDurationMs += durationMs
        }

        const dayWorkEntries = Array.from(dayWorkByTaskId.values()).sort(
          (a, b) => a.pointageId - b.pointageId
        )

        const daySessionIds = daySessionRows.map((session) => session.id_session_pointage)
        const { data: dayPauseRows } =
          daySessionIds.length > 0
            ? await supabase
                .from('pause_pointage')
                .select(
                  'id_pause_pointage, id_session_pointage, debut_pause_pointage, fin_pause_pointage, commentaire_pause_pointage, motif_arret_session:motif_arret_session!fk_pause_pointage_motif_arret_session(code_motif_arret_session, libelle_motif_arret_session)'
                )
                .in('id_session_pointage', daySessionIds)
                .order('debut_pause_pointage', { ascending: true })
            : { data: [] }

        const daySessionById = new Map<number, (typeof daySessionRows)[number]>(
          daySessionRows.map((session) => [session.id_session_pointage, session])
        )
        const dayPauseByTaskId = new Map<string, PauseEntry>()
        for (const pause of dayPauseRows ?? []) {
          if (!pause.fin_pause_pointage) {
            continue
          }
          const sourceSession = daySessionById.get(pause.id_session_pointage)
          if (!sourceSession) {
            continue
          }
          const taskMeta = dayPointageMetaById.get(sourceSession.id_pointage)
          if (!taskMeta) {
            continue
          }
          const taskGroupingKey = buildTaskGroupingKey(taskMeta.taskId, taskMeta.taskTitle)
          if (!dayPauseByTaskId.has(taskGroupingKey)) {
            dayPauseByTaskId.set(taskGroupingKey, {
              taskId: String(taskMeta.taskId),
              taskTitle: taskMeta.taskTitle,
              totalDurationMs: 0,
              pauses: [],
            })
          }

          const durationMs = getDurationMsBetween(
            pause.debut_pause_pointage,
            pause.fin_pause_pointage
          )
          const entry = dayPauseByTaskId.get(taskGroupingKey) as PauseEntry
          entry.pauses.push({
            pauseId: pause.id_pause_pointage,
            startIso: pause.debut_pause_pointage,
            endIso: pause.fin_pause_pointage,
            durationMs,
            comment: sanitizeUserComment(pause.commentaire_pause_pointage),
            stopReasonCode: pause.motif_arret_session?.code_motif_arret_session ?? null,
            stopReasonLabel: pause.motif_arret_session?.libelle_motif_arret_session ?? null,
          })
          entry.totalDurationMs += durationMs
        }

        const dayPauseEntries = Array.from(dayPauseByTaskId.values()).sort((a, b) =>
          a.taskTitle.localeCompare(b.taskTitle)
        )

        if (dayWorkEntries.length === 0 && dayPauseEntries.length === 0) {
          return null
        }

        return {
          date: targetDate,
          workEntries: dayWorkEntries,
          pauseEntries: dayPauseEntries,
        } as PointageDaySnapshot
      }

      const { data: pointageRows, error: pointageError } = await supabase
        .from('pointage')
        .select('id_pointage, id_tache, libelle_tache_libre_pointage')
        .eq('id_utilisateur_pointeur', userId)
        .eq('date_pointage', pointageDate)
        .eq('id_statut_pointage', enCoursStatusId)
        .order('id_pointage', { ascending: true })

      const restoredYesterdaySnapshot = didAutoValidateYesterday
        ? null
        : await buildDaySnapshot(yesterdayDateStamp, yesterdayRef)
      if (!cancelled) {
        setYesterdayPointageSnapshot(restoredYesterdaySnapshot)
        setIsYesterdayAutoValidated(false)
      }

      if (cancelled || pointageError || !pointageRows || pointageRows.length === 0) {
        if (!cancelled) {
          setWorkEntries([])
          setPauseEntries([])
          setPointageDayView('today')
          if (!restoredYesterdaySnapshot) {
            setYesterdayPointageSnapshot(null)
            setIsYesterdayAutoValidated(false)
          }
          setPointageMode('idle')
          setWorkElapsedMs(0)
          setPauseElapsedMs(0)
          setCurrentSessionPauseTotalMs(0)
        }
        return
      }

      const pointageIds = pointageRows.map((row) => row.id_pointage)
      const taskIds = Array.from(new Set(pointageRows.map((row) => row.id_tache)))

      const [{ data: taskRows }, { data: sessionRows, error: sessionError }] = await Promise.all([
        supabase.from('tache').select('id_tache, titre_tache').in('id_tache', taskIds),
        supabase
          .from('session_pointage')
          .select(
            'id_session_pointage, id_pointage, debut_session_pointage, fin_session_pointage, commentaire_session_pointage, motif_arret_session:motif_arret_session!fk_session_pointage_motif_arret_session(code_motif_arret_session, libelle_motif_arret_session)'
          )
          .in('id_pointage', pointageIds)
          .order('debut_session_pointage', { ascending: true }),
      ])

      if (cancelled || sessionError || !sessionRows) {
        return
      }

      const taskTitleById = new Map<number, string>(
        (taskRows ?? []).map((task) => [task.id_tache, task.titre_tache])
      )
      const pointageMetaById = new Map<number, { taskId: number; taskTitle: string }>(
        pointageRows.map((row) => [
          row.id_pointage,
          {
            taskId: row.id_tache,
            taskTitle: getResolvedTaskTitle(
              taskTitleById.get(row.id_tache),
              row.libelle_tache_libre_pointage
            ),
          },
        ])
      )
      const pointageToCanonicalByTask = new Map<string, number>()
      for (const row of pointageRows) {
        const taskTitle = getResolvedTaskTitle(
          taskTitleById.get(row.id_tache),
          row.libelle_tache_libre_pointage
        )
        const taskGroupingKey = buildTaskGroupingKey(row.id_tache, taskTitle)
        if (!pointageToCanonicalByTask.has(taskGroupingKey)) {
          pointageToCanonicalByTask.set(taskGroupingKey, row.id_pointage)
        }
      }

      const workByTaskId = new Map<string, WorkEntry>()
      let activeSession:
        | {
            id_session_pointage: number
            id_pointage: number
            debut_session_pointage: string
            fin_session_pointage: string | null
            commentaire_session_pointage: string | null
            motif_arret_session: {
              code_motif_arret_session: StopReasonCode
              libelle_motif_arret_session: string
            } | null
          }
        | null = null

      for (const session of sessionRows) {
        const taskMeta = pointageMetaById.get(session.id_pointage)
        if (!taskMeta) {
          continue
        }

        const taskGroupingKey = buildTaskGroupingKey(taskMeta.taskId, taskMeta.taskTitle)
        const canonicalPointageId =
          pointageToCanonicalByTask.get(taskGroupingKey) ?? session.id_pointage

        if (!workByTaskId.has(taskGroupingKey)) {
          workByTaskId.set(taskGroupingKey, {
            pointageId: canonicalPointageId,
            taskId: String(taskMeta.taskId),
            taskTitle: taskMeta.taskTitle,
            totalDurationMs: 0,
            sessions: [],
          })
        }

        if (session.fin_session_pointage) {
          const durationMs = getDurationMsBetween(
            session.debut_session_pointage,
            session.fin_session_pointage
          )
          const entry = workByTaskId.get(taskGroupingKey) as WorkEntry
          entry.sessions.push({
            sessionId: session.id_session_pointage,
            startIso: session.debut_session_pointage,
            endIso: session.fin_session_pointage,
            durationMs,
            comment: sanitizeUserComment(session.commentaire_session_pointage),
            stopReasonCode: session.motif_arret_session?.code_motif_arret_session ?? null,
            stopReasonLabel: session.motif_arret_session?.libelle_motif_arret_session ?? null,
          })
          entry.totalDurationMs += durationMs
        } else {
          activeSession = session
        }
      }

      const workEntriesFromDb = Array.from(workByTaskId.values()).sort(
        (a, b) => a.pointageId - b.pointageId
      )

      const sessionIds = sessionRows.map((session) => session.id_session_pointage)
      const { data: pauseRows } =
        sessionIds.length > 0
          ? await supabase
              .from('pause_pointage')
              .select(
                'id_pause_pointage, id_session_pointage, debut_pause_pointage, fin_pause_pointage, commentaire_pause_pointage, motif_arret_session:motif_arret_session!fk_pause_pointage_motif_arret_session(code_motif_arret_session, libelle_motif_arret_session)'
              )
              .in('id_session_pointage', sessionIds)
              .order('debut_pause_pointage', { ascending: true })
          : { data: [] }

      const sessionById = new Map<number, (typeof sessionRows)[number]>(
        sessionRows.map((session) => [session.id_session_pointage, session])
      )
      const pauseByTaskId = new Map<string, PauseEntry>()
      let activePause:
        | {
            id_pause_pointage: number
            id_session_pointage: number
            debut_pause_pointage: string
            fin_pause_pointage: string | null
            commentaire_pause_pointage: string | null
            motif_arret_session: {
              code_motif_arret_session: StopReasonCode
              libelle_motif_arret_session: string
            } | null
          }
        | null = null

      for (const pause of pauseRows ?? []) {
        const sourceSession = sessionById.get(pause.id_session_pointage)
        if (!sourceSession) {
          continue
        }
        const taskMeta = pointageMetaById.get(sourceSession.id_pointage)
        if (!taskMeta) {
          continue
        }
        const taskGroupingKey = buildTaskGroupingKey(taskMeta.taskId, taskMeta.taskTitle)
        if (!pauseByTaskId.has(taskGroupingKey)) {
          pauseByTaskId.set(taskGroupingKey, {
            taskId: String(taskMeta.taskId),
            taskTitle: taskMeta.taskTitle,
            totalDurationMs: 0,
            pauses: [],
          })
        }

        if (pause.fin_pause_pointage) {
          const durationMs = getDurationMsBetween(
            pause.debut_pause_pointage,
            pause.fin_pause_pointage
          )
          const entry = pauseByTaskId.get(taskGroupingKey) as PauseEntry
          entry.pauses.push({
            pauseId: pause.id_pause_pointage,
            startIso: pause.debut_pause_pointage,
            endIso: pause.fin_pause_pointage,
            durationMs,
            comment: sanitizeUserComment(pause.commentaire_pause_pointage),
            stopReasonCode: pause.motif_arret_session?.code_motif_arret_session ?? null,
            stopReasonLabel: pause.motif_arret_session?.libelle_motif_arret_session ?? null,
          })
          entry.totalDurationMs += durationMs
        } else {
          activePause = pause
        }
      }

      const completedPauseMsBySessionId = new Map<number, number>()
      for (const pause of pauseRows ?? []) {
        if (!pause.fin_pause_pointage) {
          continue
        }

        const completedPauseMs = getDurationMsBetween(
          pause.debut_pause_pointage,
          pause.fin_pause_pointage
        )
        completedPauseMsBySessionId.set(
          pause.id_session_pointage,
          (completedPauseMsBySessionId.get(pause.id_session_pointage) ?? 0) + completedPauseMs
        )
      }

      const pauseEntriesFromDb = Array.from(pauseByTaskId.values()).sort((a, b) =>
        a.taskTitle.localeCompare(b.taskTitle)
      )

      if (cancelled) {
        return
      }

      setWorkEntries(workEntriesFromDb)
      setPauseEntries(pauseEntriesFromDb)

      if (!activeSession) {
        setPointageMode('idle')
        setWorkElapsedMs(0)
        setPauseElapsedMs(0)
        setCurrentSessionPauseTotalMs(0)
        return
      }

      const activeTaskMeta = pointageMetaById.get(activeSession.id_pointage)
      if (!activeTaskMeta) {
        setPointageMode('idle')
        setWorkElapsedMs(0)
        setPauseElapsedMs(0)
        setCurrentSessionPauseTotalMs(0)
        return
      }
      const activeTaskIdAsString = String(activeTaskMeta.taskId)
      const activeWorkEntry =
        workEntriesFromDb.find(
          (entry) =>
            buildTaskGroupingKey(entry.taskId, entry.taskTitle) ===
            buildTaskGroupingKey(activeTaskMeta.taskId, activeTaskMeta.taskTitle)
        ) ?? null
      const baseWorkMs = activeWorkEntry?.totalDurationMs ?? 0

      const completedPauseMsForActiveSession =
        completedPauseMsBySessionId.get(activeSession.id_session_pointage) ?? 0

      const estimatedServerNowMs = getEstimatedServerNowMs()
      const activePauseElapsedMs =
        activePause?.fin_pause_pointage
          ? 0
          : Math.max(
              estimatedServerNowMs -
                parseStoredTimestamp(activePause?.debut_pause_pointage ?? getLocalTimestamp())
                  .getTime(),
              0
            )
      const runningWorkMs =
        activePause && !activePause.fin_pause_pointage
          ? Math.max(
              getDurationMsBetween(
                activeSession.debut_session_pointage,
                activePause.debut_pause_pointage
              ) - completedPauseMsForActiveSession,
              0
            )
          : Math.max(
              estimatedServerNowMs -
                parseStoredTimestamp(activeSession.debut_session_pointage).getTime() -
                completedPauseMsForActiveSession,
              0
            )

      setCurrentPointageId(activeSession.id_pointage)
      setCurrentSessionPointageId(activeSession.id_session_pointage)
      setCurrentSessionStartedAtIso(activeSession.debut_session_pointage)
      setCurrentWorkEntryId(activeWorkEntry?.pointageId ?? activeSession.id_pointage)
      setCurrentSessionBaseElapsedMs(baseWorkMs)
      setCurrentSessionPauseTotalMs(completedPauseMsForActiveSession)
      setWorkElapsedMs(baseWorkMs + runningWorkMs)
      setTaskChoice(activeTaskIdAsString)
      setOtherTaskLabel(activeTaskMeta.taskTitle)
      const isSameActiveSession =
        currentSessionPointageIdRef.current === activeSession.id_session_pointage &&
        pointageModeRef.current !== 'idle'
      setPointageComment(
        isSameActiveSession
          ? pointageCommentRef.current
          : sanitizeUserComment(activeSession.commentaire_session_pointage) ??
              (activeWorkEntry ? getLatestWorkComment(activeWorkEntry) : '')
      )

      if (activePause && !activePause.fin_pause_pointage) {
        setCurrentPausePointageId(activePause.id_pause_pointage)
        setCurrentPauseStartedAtIso(activePause.debut_pause_pointage)
        setPauseElapsedMs(activePauseElapsedMs)
        setPauseComment(sanitizeUserComment(activePause.commentaire_pause_pointage) ?? '')
        setPointageMode('paused')
      } else {
        setCurrentPausePointageId(null)
        setCurrentPauseStartedAtIso(null)
        setPauseElapsedMs(0)
        setPauseComment('')
        setPointageMode('running')
      }
    }

    void restorePointageState()
    return () => {
      cancelled = true
    }
  }, [
    activeMenu,
    activePointagesSubMenu,
    applyAutoClosureForUser,
    autoValidateDayIfNoActiveSession,
    autoValidatePendingDaysBefore,
    connectedUsername,
    getEstimatedServerDateStamp,
    getEstimatedServerNowDate,
    getEstimatedServerNowMs,
    getResolvedTaskTitle,
    getStatusIdByCode,
    pointageRefreshKey,
    syncServerClock,
  ])

  const selectedDate = useMemo(
    () => new Date(selectedYear, selectedMonth - 1, selectedDay),
    [selectedYear, selectedMonth, selectedDay]
  )

  const monthStart = useMemo(
    () => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1),
    [selectedDate]
  )
  const monthEnd = useMemo(
    () => new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0),
    [selectedDate]
  )

  const weekDays = useMemo(() => getWeekFromMonday(selectedDate), [selectedDate])
  const displayedWeekMonday = weekDays[0]
  const isCurrentWeek = isSameCalendarDay(displayedWeekMonday, currentWeekMonday)
  const isCurrentMonth =
    selectedDate.getFullYear() === todayAtLoad.getFullYear() &&
    selectedDate.getMonth() === todayAtLoad.getMonth()
  const isCurrentPeriod = activeAgendaTab === 'semaine' ? isCurrentWeek : isCurrentMonth

  const weekRangeLabel = `${weekDays[0].toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })} - ${weekDays[6].toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })}`
  const monthRangeLabel = `${monthStart.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })} - ${monthEnd.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })}`

  useEffect(() => {
    const isAgendaViewActive = activeTab === 'tab1' && activeMenu === 'accueil'
    if (!isAgendaViewActive || !connectedUsername) {
      return
    }

    let cancelled = false

    const loadAgendaDaySummaries = async () => {
      const termineStatusId = await getStatusIdByCode('TERMINE')
      if (termineStatusId === null) {
        return
      }

      const { data: userData, error: userError } = await supabase
        .from('utilisateur')
        .select('id_utilisateur, id_statut_utilisateur!inner(code_statut_utilisateur)')
        .eq('username_utilisateur', connectedUsername)
        .eq('id_statut_utilisateur.code_statut_utilisateur', 'ACTIVE')
        .single()

      if (cancelled || userError || !userData) {
        return
      }

      const rangeStartDate = activeAgendaTab === 'semaine' ? weekDays[0] : monthStart
      const rangeEndDate = activeAgendaTab === 'semaine' ? weekDays[6] : monthEnd
      const rangeStart = getLocalDateStamp(rangeStartDate)
      const rangeEnd = getLocalDateStamp(rangeEndDate)

      const { data: pointageRows, error: pointageError } = await supabase
        .from('pointage')
        .select('id_pointage, id_tache, date_pointage, libelle_tache_libre_pointage')
        .eq('id_utilisateur_pointeur', userData.id_utilisateur)
        .eq('id_statut_pointage', termineStatusId)
        .gte('date_pointage', rangeStart)
        .lte('date_pointage', rangeEnd)
        .order('date_pointage', { ascending: true })
        .order('id_pointage', { ascending: true })

      if (cancelled || pointageError || !pointageRows || pointageRows.length === 0) {
        if (!cancelled) {
          setAgendaDaySummaries({})
        }
        return
      }

      const pointageIds = pointageRows.map((row) => row.id_pointage)
      const taskIds = Array.from(new Set(pointageRows.map((row) => row.id_tache)))
      const [{ data: taskRows }, { data: sessionRows, error: sessionError }] = await Promise.all([
        supabase.from('tache').select('id_tache, titre_tache').in('id_tache', taskIds),
        supabase
          .from('session_pointage')
          .select(
            'id_session_pointage, id_pointage, debut_session_pointage, fin_session_pointage, commentaire_session_pointage, motif_arret_session:motif_arret_session!fk_session_pointage_motif_arret_session(code_motif_arret_session, libelle_motif_arret_session)'
          )
          .in('id_pointage', pointageIds)
          .order('debut_session_pointage', { ascending: true }),
      ])

      if (cancelled || sessionError || !sessionRows) {
        return
      }

      const taskTitleById = new Map<number, string>(
        (taskRows ?? []).map((task) => [task.id_tache, task.titre_tache])
      )
      const pointageById = new Map<
        number,
        { taskId: number; dateStamp: string; taskTitle: string }
      >(
        pointageRows.map((row) => [
          row.id_pointage,
          {
            taskId: row.id_tache,
            dateStamp: row.date_pointage,
            taskTitle: getResolvedTaskTitle(
              taskTitleById.get(row.id_tache),
              row.libelle_tache_libre_pointage
            ),
          },
        ])
      )

      const summariesByDay = new Map<string, Map<string, DayTaskSummary>>()
      for (const session of sessionRows) {
        if (!session.fin_session_pointage) {
          continue
        }

        const sourcePointage = pointageById.get(session.id_pointage)
        if (!sourcePointage) {
          continue
        }

        if (!summariesByDay.has(sourcePointage.dateStamp)) {
          summariesByDay.set(sourcePointage.dateStamp, new Map())
        }

        const taskMap = summariesByDay.get(sourcePointage.dateStamp) as Map<string, DayTaskSummary>
        const taskId = String(sourcePointage.taskId)
        const taskTitle = sourcePointage.taskTitle
        const taskKey = buildTaskGroupingKey(taskId, taskTitle)
        const durationMs = getDurationMsBetween(
          session.debut_session_pointage,
          session.fin_session_pointage
        )
        const latestComment = sanitizeUserComment(session.commentaire_session_pointage) || '-'
        const existingSummary = taskMap.get(taskKey)

        const existingComment = existingSummary?.comment ?? '-'
        const shouldAppendComment =
          latestComment !== '-' &&
          latestComment !== existingComment &&
          !existingComment.split('-').map((part) => part.trim()).includes(latestComment)

        taskMap.set(taskKey, {
          taskKey,
          taskId,
          taskTitle,
          comment:
            latestComment === '-'
              ? existingComment
              : existingComment === '-'
                ? latestComment
                : shouldAppendComment
                  ? `${existingComment} - ${latestComment}`
                  : existingComment,
          totalDurationMs: (existingSummary?.totalDurationMs ?? 0) + durationMs,
        })
      }

      const nextSummaries: Record<string, DaySummary> = {}
      for (const [dateStamp, taskMap] of summariesByDay.entries()) {
        const tasks = Array.from(taskMap.values()).sort((a, b) =>
          a.taskTitle.localeCompare(b.taskTitle)
        )
        nextSummaries[dateStamp] = {
          dateStamp,
          tasks,
          totalWorkMs: tasks.reduce((sum, task) => sum + task.totalDurationMs, 0),
        }
      }

      if (!cancelled) {
        setAgendaDaySummaries(nextSummaries)
      }
    }

    void loadAgendaDaySummaries()
    return () => {
      cancelled = true
    }
  }, [
    activeAgendaTab,
    activeMenu,
    activeTab,
    connectedUsername,
    getResolvedTaskTitle,
    getStatusIdByCode,
    monthEnd,
    monthStart,
    weekDays,
  ])

  const monthCalendarCells = useMemo(() => {
    const startWeekDay = monthStart.getDay()
    const leadingEmptyCells = startWeekDay === 0 ? 6 : startWeekDay - 1
    const daysCount = monthEnd.getDate()
    const days = Array.from({ length: daysCount }, (_, index) => {
      const dayDate = new Date(monthStart)
      dayDate.setDate(index + 1)
      return dayDate
    })
    const trailingEmptyCells =
      (7 - ((leadingEmptyCells + days.length) % 7)) % 7

    return [
      ...Array.from({ length: leadingEmptyCells }, () => null),
      ...days,
      ...Array.from({ length: trailingEmptyCells }, () => null),
    ]
  }, [monthStart, monthEnd])

  const goToPreviousWeek = () => {
    const previousWeekMonday = addDays(displayedWeekMonday, -7)
    const nextDate = isSameCalendarDay(previousWeekMonday, currentWeekMonday)
      ? todayAtLoad
      : previousWeekMonday
    setSelectedDay(nextDate.getDate())
    setSelectedMonth(nextDate.getMonth() + 1)
    setSelectedYear(nextDate.getFullYear())
  }

  const goToNextWeek = () => {
    const nextWeekMonday = addDays(displayedWeekMonday, 7)
    const nextDate = isSameCalendarDay(nextWeekMonday, currentWeekMonday)
      ? todayAtLoad
      : nextWeekMonday
    setSelectedDay(nextDate.getDate())
    setSelectedMonth(nextDate.getMonth() + 1)
    setSelectedYear(nextDate.getFullYear())
  }

  const resetToToday = () => {
    setSelectedDay(todayAtLoad.getDate())
    setSelectedMonth(todayAtLoad.getMonth() + 1)
    setSelectedYear(todayAtLoad.getFullYear())
  }

  const goToPreviousMonth = () => {
    const previousMonthStart = addMonths(monthStart, -1)
    const nextDate =
      previousMonthStart.getFullYear() === todayAtLoad.getFullYear() &&
      previousMonthStart.getMonth() === todayAtLoad.getMonth()
        ? todayAtLoad
        : previousMonthStart
    setSelectedDay(nextDate.getDate())
    setSelectedMonth(nextDate.getMonth() + 1)
    setSelectedYear(nextDate.getFullYear())
  }

  const goToNextMonth = () => {
    const nextMonthStart = addMonths(monthStart, 1)
    const nextDate =
      nextMonthStart.getFullYear() === todayAtLoad.getFullYear() &&
      nextMonthStart.getMonth() === todayAtLoad.getMonth()
        ? todayAtLoad
        : nextMonthStart
    setSelectedDay(nextDate.getDate())
    setSelectedMonth(nextDate.getMonth() + 1)
    setSelectedYear(nextDate.getFullYear())
  }

  useEffect(() => {
    if (pointageMode !== 'running' || !currentSessionStartedAtIso) return

    const syncWorkElapsed = () => {
      const elapsedMs = Math.max(
        getEstimatedServerNowMs() -
          parseStoredTimestamp(currentSessionStartedAtIso).getTime() -
          currentSessionPauseTotalMs,
        0
      )
      setWorkElapsedMs(currentSessionBaseElapsedMs + elapsedMs)
    }

    syncWorkElapsed()
    const timer = setInterval(syncWorkElapsed, 1000)
    return () => clearInterval(timer)
  }, [
    currentSessionBaseElapsedMs,
    currentSessionPauseTotalMs,
    currentSessionStartedAtIso,
    getEstimatedServerNowMs,
    pointageMode,
  ])

  useEffect(() => {
    if (pointageMode !== 'paused' || !currentPauseStartedAtIso || !currentSessionStartedAtIso) return

    const syncPausedState = () => {
      setPauseElapsedMs(
        Math.max(
          getEstimatedServerNowMs() - parseStoredTimestamp(currentPauseStartedAtIso).getTime(),
          0
        )
      )
      setWorkElapsedMs(
        currentSessionBaseElapsedMs +
          Math.max(
            getDurationMsBetween(currentSessionStartedAtIso, currentPauseStartedAtIso) -
              currentSessionPauseTotalMs,
            0
          )
      )
    }

    syncPausedState()
    const timer = setInterval(syncPausedState, 1000)
    return () => clearInterval(timer)
  }, [
    currentPauseStartedAtIso,
    currentSessionBaseElapsedMs,
    currentSessionPauseTotalMs,
    currentSessionStartedAtIso,
    getEstimatedServerNowMs,
    pointageMode,
  ])

  const formatDuration = (durationMs: number) => {
    const totalSeconds = Math.floor(durationMs / 1000)
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0')
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
    const seconds = String(totalSeconds % 60).padStart(2, '0')
    return `${hours}:${minutes}:${seconds}`
  }

  const formatDurationParts = (durationMs: number) => {
    const totalSeconds = Math.floor(durationMs / 1000)
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0')
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
    const seconds = String(totalSeconds % 60).padStart(2, '0')
    return { hours, minutes, seconds }
  }

  const formatTimeLabel = (isoString: string) =>
    parseStoredTimestamp(isoString).toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
    })

  const totalTrackedWorkMs = useMemo(
    () => workEntries.reduce((sum, entry) => sum + entry.totalDurationMs, 0),
    [workEntries]
  )
  const totalTrackedPauseMs = useMemo(
    () => pauseEntries.reduce((sum, entry) => sum + entry.totalDurationMs, 0),
    [pauseEntries]
  )

  const currentWorkEntry =
    currentWorkEntryId === null
      ? null
      : workEntries.find((entry) => entry.pointageId === currentWorkEntryId) ?? null
  const currentTaskTitle =
    currentWorkEntry?.taskTitle ||
    normalizeFreeTaskLabel(otherTaskLabel) ||
    taskOptions.find((task) => task.id === taskChoice)?.title ||
    'TÃ¢che non renseignÃ©e'
  const displayedTotalWorkMs = useMemo(() => {
    if (currentWorkEntry) {
      return totalTrackedWorkMs + Math.max(workElapsedMs - currentWorkEntry.totalDurationMs, 0)
    }

    if (pointageMode !== 'idle') {
      return totalTrackedWorkMs + workElapsedMs
    }

    return totalTrackedWorkMs
  }, [currentWorkEntry, pointageMode, totalTrackedWorkMs, workElapsedMs])
  const displayedTotalPauseMs = useMemo(() => {
    if (pointageMode === 'paused') {
      return totalTrackedPauseMs + pauseElapsedMs
    }

    return totalTrackedPauseMs
  }, [pauseElapsedMs, pointageMode, totalTrackedPauseMs])
  const isYesterdayView = pointageDayView === 'yesterday' && yesterdayPointageSnapshot !== null
  const viewedWorkEntries = isYesterdayView ? yesterdayPointageSnapshot.workEntries : workEntries
  const viewedPauseEntries = isYesterdayView ? yesterdayPointageSnapshot.pauseEntries : pauseEntries
  const viewedWorkTotalMs = viewedWorkEntries.reduce((sum, entry) => sum + entry.totalDurationMs, 0)
  const viewedPauseTotalMs = viewedPauseEntries.reduce(
    (sum, entry) => sum + entry.totalDurationMs,
    0
  )
  const yesterdayLabel = yesterdayPointageSnapshot
    ? yesterdayPointageSnapshot.date.toLocaleDateString('fr-FR')
    : ''
  const todayLabel = getEstimatedServerNowDate().toLocaleDateString('fr-FR')
  const monthDetailSummary = monthDetailDate
    ? agendaDaySummaries[getLocalDateStamp(monthDetailDate)] ?? null
    : null
  const isValidationDailyTargetReached =
    expectedDailyDurationMs !== null &&
    (isYesterdayView ? viewedWorkTotalMs : displayedTotalWorkMs) >= expectedDailyDurationMs
  const pointageReviewSourceSummary = useMemo(() => {
    const summary = summarizeWorkEntries(viewedWorkEntries)
    return {
      tasks: summary.tasks,
      totalWorkMs: isYesterdayView ? viewedWorkTotalMs : displayedTotalWorkMs,
    }
  }, [displayedTotalWorkMs, isYesterdayView, viewedWorkEntries, viewedWorkTotalMs])

  const buildWorkEntryFromSessions = (
    pointageId: number,
    taskId: string,
    taskTitle: string,
    sessions: Array<{
      id_session_pointage: number
      debut_session_pointage: string
      fin_session_pointage: string | null
      commentaire_session_pointage: string | null
      motif_arret_session: {
        code_motif_arret_session: StopReasonCode
        libelle_motif_arret_session: string
      } | null
    }>
  ): WorkEntry => {
    const normalizedSessions = sessions
      .filter((session) => session.fin_session_pointage)
      .map((session) => {
        return {
          sessionId: session.id_session_pointage,
          startIso: session.debut_session_pointage,
          endIso: session.fin_session_pointage as string,
          durationMs: getDurationMsBetween(
            session.debut_session_pointage,
            session.fin_session_pointage as string
          ),
          comment: sanitizeUserComment(session.commentaire_session_pointage),
          stopReasonCode: session.motif_arret_session?.code_motif_arret_session ?? null,
          stopReasonLabel: session.motif_arret_session?.libelle_motif_arret_session ?? null,
        }
      })

    return {
      pointageId,
      taskId,
      taskTitle,
      totalDurationMs: normalizedSessions.reduce((sum, session) => sum + session.durationMs, 0),
      sessions: normalizedSessions,
    }
  }

  const isSameWorkEntryIdentity = useCallback(
    (entry: WorkEntry, selectedTaskId: number, resolvedTaskTitle: string) =>
      buildTaskGroupingKey(entry.taskId, entry.taskTitle) ===
      buildTaskGroupingKey(selectedTaskId, resolvedTaskTitle),
    []
  )

  const getExistingPointageEntryForToday = async (
    selectedTaskId: number,
    taskTitle: string,
    pointageDate: string,
    freeTaskLabel?: string | null
  ) => {
    const resolvedTaskTitle = getResolvedTaskTitle(taskTitle, freeTaskLabel)
    const normalizedFreeTaskLabel = normalizeFreeTaskLabel(freeTaskLabel ?? '')
    const existingLocalEntry = workEntries.find((entry) =>
      isSameWorkEntryIdentity(entry, selectedTaskId, resolvedTaskTitle)
    )
    if (existingLocalEntry) {
      return existingLocalEntry
    }

    if (!connectedUserId) {
      return null
    }

    const enCoursStatusId = await getStatusIdByCode('EN_COURS')
    if (enCoursStatusId === null) {
      return null
    }

    const { data: pointageRows, error: pointageLookupError } = await supabase
      .from('pointage')
      .select('id_pointage')
      .eq('id_utilisateur_pointeur', connectedUserId)
      .eq('id_tache', selectedTaskId)
      .eq('date_pointage', pointageDate)
      .eq('id_statut_pointage', enCoursStatusId)
      .order('id_pointage', { ascending: true })

    let filteredPointageRows = pointageRows ?? []
    if (normalizedFreeTaskLabel) {
      const { data: freePointageRows, error: freePointageError } = await supabase
        .from('pointage')
        .select('id_pointage')
        .eq('id_utilisateur_pointeur', connectedUserId)
        .eq('id_tache', selectedTaskId)
        .eq('date_pointage', pointageDate)
        .eq('id_statut_pointage', enCoursStatusId)
        .eq('libelle_tache_libre_pointage', normalizedFreeTaskLabel)
        .order('id_pointage', { ascending: true })

      if (freePointageError) {
        return null
      }
      filteredPointageRows = freePointageRows ?? []
    } else {
      const { data: normalPointageRows, error: normalPointageError } = await supabase
        .from('pointage')
        .select('id_pointage')
        .eq('id_utilisateur_pointeur', connectedUserId)
        .eq('id_tache', selectedTaskId)
        .eq('date_pointage', pointageDate)
        .eq('id_statut_pointage', enCoursStatusId)
        .is('libelle_tache_libre_pointage', null)
        .order('id_pointage', { ascending: true })

      if (normalPointageError) {
        return null
      }
      filteredPointageRows = normalPointageRows ?? []
    }

    if (pointageLookupError || filteredPointageRows.length === 0) {
      return null
    }

    const canonicalPointageId = filteredPointageRows[0].id_pointage
    const pointageIds = filteredPointageRows.map((row) => row.id_pointage)
    const existingEntry = workEntries.find((entry) => entry.pointageId === canonicalPointageId)
    if (existingEntry) {
      return existingEntry
    }

    const { data: sessionRows, error: sessionLookupError } = await supabase
      .from('session_pointage')
      .select(
        'id_session_pointage, debut_session_pointage, fin_session_pointage, commentaire_session_pointage, motif_arret_session:motif_arret_session!fk_session_pointage_motif_arret_session(code_motif_arret_session, libelle_motif_arret_session)'
      )
      .in('id_pointage', pointageIds)
      .order('debut_session_pointage', { ascending: true })

    if (sessionLookupError || !sessionRows) {
      return {
        pointageId: canonicalPointageId,
        taskId: String(selectedTaskId),
        taskTitle,
        totalDurationMs: 0,
        sessions: [],
      }
    }

    const builtEntry = buildWorkEntryFromSessions(
      canonicalPointageId,
      String(selectedTaskId),
      resolvedTaskTitle,
      sessionRows
    )

    setWorkEntries((previousEntries) => {
      if (previousEntries.some((entry) => entry.pointageId === builtEntry.pointageId)) {
        return previousEntries
      }
      return [...previousEntries, builtEntry]
    })

    return builtEntry
  }

  const registerCompletedPause = useCallback(
    (
      pauseId: number,
      startIso: string,
      endIso: string,
      comment: string | null,
      stopReasonCode: StopReasonCode | null,
      stopReasonLabel: string | null
    ) => {
      const durationMs = getDurationMsBetween(startIso, endIso)
      const taskId = currentWorkEntry?.taskId ?? taskChoice
      const taskTitle = currentTaskTitle

      if (!taskId) {
        return
      }

      setPauseEntries((previousEntries) => {
        const nextPause: PauseSegmentEntry = {
          pauseId,
          startIso,
          endIso,
          durationMs,
          comment,
          stopReasonCode,
          stopReasonLabel,
        }

        const existingEntry = previousEntries.find((entry) => entry.taskId === taskId)
        if (!existingEntry) {
          return [
            ...previousEntries,
            {
              taskId,
              taskTitle,
              totalDurationMs: durationMs,
              pauses: [nextPause],
            },
          ]
        }

        return previousEntries.map((entry) =>
          entry.taskId === taskId
            ? {
                ...entry,
                taskTitle,
                totalDurationMs: entry.totalDurationMs + durationMs,
                pauses: [...entry.pauses, nextPause],
              }
            : entry
        )
      })
    },
    [currentTaskTitle, currentWorkEntry, taskChoice]
  )

  const closeCurrentSession = async (
    sessionComment: string | null,
    stopReasonCode: StopReasonCode = 'ARRET_MANUEL',
    forcedSessionEndIso?: string
  ) => {
    if (!currentSessionPointageId) {
      return false
    }

    await syncServerClock()
    let resolvedSessionEndIso = forcedSessionEndIso ?? null

    if (!forcedSessionEndIso) {
      const pauseFinalComment = pauseComment.trim() || null
      const stopResult = await postPointageApi<{
        fin_session_pointage: string | null
        fin_pause_pointage: string | null
      }>('/api/pointage/stop', {
        sessionId: currentSessionPointageId,
        sessionComment,
        pauseId: pointageMode === 'paused' ? currentPausePointageId : null,
        pauseComment: pauseFinalComment,
        stopReasonCode,
      })

      if (!stopResult.ok) {
        setPointageStopError(stopResult.error || "Impossible d'arrêter le pointage.")
        return false
      }

      resolvedSessionEndIso = stopResult.data.fin_session_pointage
      const rpcPauseEndIso = stopResult.data.fin_pause_pointage

      if (pointageMode === 'paused' && currentPausePointageId && currentPauseStartedAtIso) {
        registerCompletedPause(
          currentPausePointageId,
          currentPauseStartedAtIso,
          rpcPauseEndIso ?? resolvedSessionEndIso ?? currentPauseStartedAtIso,
          pauseFinalComment,
          stopReasonCode,
          stopReasonCode === 'INACTIVITE' ? "Session arrêtée pour inactivité" : null
        )
      }
    }

    if (!resolvedSessionEndIso) {
      return false
    }

    const finishedEntryId = currentWorkEntryId ?? currentPointageId
    const sessionStartIso = currentSessionStartedAtIso ?? resolvedSessionEndIso
    const activePauseDurationMs =
      pointageMode === 'paused' && currentPauseStartedAtIso
        ? getDurationMsBetween(currentPauseStartedAtIso, resolvedSessionEndIso)
        : 0
    const sessionDurationMs = Math.max(
      getDurationMsBetween(sessionStartIso, resolvedSessionEndIso) -
        currentSessionPauseTotalMs -
        activePauseDurationMs,
      0
    )

    if (finishedEntryId !== null) {
      setWorkEntries((previousEntries) => {
        const nextSession: WorkSessionEntry = {
          sessionId: currentSessionPointageId,
          startIso: sessionStartIso,
          endIso: resolvedSessionEndIso,
          durationMs: sessionDurationMs,
          comment: sessionComment,
          stopReasonCode,
          stopReasonLabel:
            stopReasonCode === 'INACTIVITE' ? "Session arrêtée pour inactivité" : null,
        }

        const existingEntry = previousEntries.find(
          (entry) => entry.pointageId === finishedEntryId
        )

        if (!existingEntry) {
          return [
            ...previousEntries,
            {
              pointageId: finishedEntryId,
              taskId: taskChoice,
              taskTitle: taskLabel,
              totalDurationMs: sessionDurationMs,
              sessions: [nextSession],
            },
          ]
        }

        return previousEntries.map((entry) =>
          entry.pointageId === finishedEntryId
            ? {
                ...entry,
                totalDurationMs: entry.totalDurationMs + sessionDurationMs,
                sessions: [...entry.sessions, nextSession],
              }
            : entry
        )
      })
    }

    setPointageMode('idle')
    setWorkElapsedMs(0)
    setPauseElapsedMs(0)
    setPointageComment('')
    setPauseComment('')
    setPointageStopError('')
    setCurrentSessionPointageId(null)
    setCurrentPausePointageId(null)
    setCurrentPauseStartedAtIso(null)
    setCurrentWorkEntryId(null)
    setCurrentSessionBaseElapsedMs(0)
    setCurrentSessionPauseTotalMs(0)
    setCurrentSessionStartedAtIso(null)
    return true
  }

  const getActiveSessionSnapshot = useCallback(async (): Promise<ActiveSessionSnapshot | null> => {
    if (!connectedUserId) {
      return null
    }

    const { data: userPointages, error: pointageError } = await supabase
      .from('pointage')
      .select('id_pointage')
      .eq('id_utilisateur_pointeur', connectedUserId)

    if (pointageError || !userPointages || userPointages.length === 0) {
      return null
    }

    const pointageIds = userPointages.map((row) => row.id_pointage)
    const { data: activeSessions, error: sessionError } = await supabase
      .from('session_pointage')
      .select('id_session_pointage, id_pointage')
      .in('id_pointage', pointageIds)
      .is('fin_session_pointage', null)
      .order('debut_session_pointage', { ascending: false })
      .limit(1)

    if (sessionError || !activeSessions || activeSessions.length === 0) {
      return null
    }

    return {
      sessionId: activeSessions[0].id_session_pointage,
      pointageId: activeSessions[0].id_pointage,
    }
  }, [connectedUserId])

  const rolloverActivePointageAtMidnight = useCallback(async () => {
    if (
      midnightTransitionPendingRef.current ||
      !currentSessionPointageIdRef.current ||
      !currentSessionStartedAtIso ||
      !taskChoice ||
      !connectedUserId
    ) {
      return
    }

    await syncServerClock()
    const currentSessionDate = getLocalDateStamp(parseStoredTimestamp(currentSessionStartedAtIso))
    const serverCurrentDate = getEstimatedServerDateStamp()
    if (currentSessionDate === serverCurrentDate) {
      return
    }

    midnightTransitionPendingRef.current = true
    setPointageMutationPending(true)

    try {
      const now = getEstimatedServerNowDate()
      const endOfPreviousDay = new Date(now)
      endOfPreviousDay.setHours(0, 0, 0, 0)
      endOfPreviousDay.setMilliseconds(endOfPreviousDay.getMilliseconds() - 1)
      const sessionEndIso = endOfPreviousDay.toISOString()

      const midnightStart = new Date(now)
      midnightStart.setHours(0, 0, 0, 0)
      const nextSessionStartIso = midnightStart.toISOString()
      const nextPointageDate = getLocalDateStamp(midnightStart)

      const sessionComment = pointageCommentRef.current.trim() || null
      const pauseFinalComment = pauseCommentRef.current.trim() || null
      const rolloverResult = await postPointageApi<{
        nextPointageId: number | null
        nextSessionPointageId: number | null
        nextSessionStartedAtIso: string | null
        nextPausePointageId: number | null
        nextPauseStartedAtIso: string | null
      }>('/api/pointage/rollover', {
        sessionId: currentSessionPointageIdRef.current,
        pauseId: pointageModeRef.current === 'paused' ? currentPausePointageId : null,
        mode: pointageModeRef.current,
        sessionComment,
        pauseComment: pauseFinalComment,
        sessionEndIso,
        nextSessionStartIso,
        nextPointageDate,
      })

      if (!rolloverResult.ok) {
        return
      }

      const finishedEntryId = currentWorkEntryId ?? currentPointageId
      const activePauseDurationMs =
        pointageModeRef.current === 'paused' && currentPauseStartedAtIso
          ? getDurationMsBetween(currentPauseStartedAtIso, sessionEndIso)
          : 0
      const closedSessionDurationMs = Math.max(
        getDurationMsBetween(currentSessionStartedAtIso, sessionEndIso) -
          currentSessionPauseTotalMs -
          activePauseDurationMs,
        0
      )
      const yesterdayDate = new Date(now)
      yesterdayDate.setDate(yesterdayDate.getDate() - 1)
      yesterdayDate.setHours(0, 0, 0, 0)
      const yesterdayDateStamp = getLocalDateStamp(yesterdayDate)

      await autoValidatePendingDaysBefore(connectedUserId, yesterdayDateStamp)
      await postPointageApi<{ validatedCount: number }>('/api/pointage/validate', {
        pointageDate: yesterdayDateStamp,
      })

      let yesterdayWorkEntries = workEntries
      if (finishedEntryId !== null) {
        const nextSession: WorkSessionEntry = {
          sessionId: currentSessionPointageIdRef.current as number,
          startIso: currentSessionStartedAtIso,
          endIso: sessionEndIso,
          durationMs: closedSessionDurationMs,
          comment: sessionComment,
          stopReasonCode: 'ARRET_AUTO',
          stopReasonLabel: 'Arrêt automatique de la session',
        }
        const existingEntry = yesterdayWorkEntries.find(
          (entry) => entry.pointageId === finishedEntryId
        )
        if (!existingEntry) {
          yesterdayWorkEntries = [
            ...yesterdayWorkEntries,
            {
              pointageId: finishedEntryId,
              taskId: taskChoice,
              taskTitle: currentTaskTitle,
              totalDurationMs: closedSessionDurationMs,
              sessions: [nextSession],
            },
          ]
        } else {
          yesterdayWorkEntries = yesterdayWorkEntries.map((entry) =>
            entry.pointageId === finishedEntryId
              ? {
                  ...entry,
                  totalDurationMs: entry.totalDurationMs + closedSessionDurationMs,
                  sessions: [...entry.sessions, nextSession],
                }
              : entry
          )
        }
      }

      let yesterdayPauseEntries = pauseEntries
      if (pointageModeRef.current === 'paused' && currentPausePointageId && currentPauseStartedAtIso) {
        const pauseFinalComment = pauseCommentRef.current.trim() || null
        const taskIdForPause = currentWorkEntry?.taskId ?? taskChoice
        const pauseDurationMs = getDurationMsBetween(currentPauseStartedAtIso, sessionEndIso)
        const nextPause: PauseSegmentEntry = {
          pauseId: currentPausePointageId,
          startIso: currentPauseStartedAtIso,
          endIso: sessionEndIso,
          durationMs: pauseDurationMs,
          comment: pauseFinalComment,
          stopReasonCode: 'ARRET_AUTO',
          stopReasonLabel: 'Arrêt automatique de la session',
        }
        const existingPauseEntry = yesterdayPauseEntries.find((entry) => entry.taskId === taskIdForPause)
        if (!existingPauseEntry) {
          yesterdayPauseEntries = [
            ...yesterdayPauseEntries,
            {
              taskId: taskIdForPause,
              taskTitle: currentTaskTitle,
              totalDurationMs: pauseDurationMs,
              pauses: [nextPause],
            },
          ]
        } else {
          yesterdayPauseEntries = yesterdayPauseEntries.map((entry) =>
            entry.taskId === taskIdForPause
              ? {
                  ...entry,
                  taskTitle: currentTaskTitle,
                  totalDurationMs: entry.totalDurationMs + pauseDurationMs,
                  pauses: [...entry.pauses, nextPause],
                }
              : entry
          )
        }
      }

      setYesterdayPointageSnapshot({
        date: yesterdayDate,
        workEntries: yesterdayWorkEntries,
        pauseEntries: yesterdayPauseEntries,
      })
      setIsYesterdayAutoValidated(true)
      setPointageDayView('today')

      if (finishedEntryId !== null) {
        setWorkEntries((previousEntries) => {
          const nextSession: WorkSessionEntry = {
            sessionId: currentSessionPointageIdRef.current as number,
            startIso: currentSessionStartedAtIso,
            endIso: sessionEndIso,
            durationMs: closedSessionDurationMs,
            comment: sessionComment,
            stopReasonCode: 'ARRET_AUTO',
            stopReasonLabel: 'Arrêt automatique de la session',
          }

          const existingEntry = previousEntries.find((entry) => entry.pointageId === finishedEntryId)
          if (!existingEntry) {
            return [
              ...previousEntries,
              {
                pointageId: finishedEntryId,
                taskId: taskChoice,
                taskTitle: currentTaskTitle,
                totalDurationMs: closedSessionDurationMs,
                sessions: [nextSession],
              },
            ]
          }

          return previousEntries.map((entry) =>
            entry.pointageId === finishedEntryId
              ? {
                  ...entry,
                  totalDurationMs: entry.totalDurationMs + closedSessionDurationMs,
                  sessions: [...entry.sessions, nextSession],
                }
              : entry
          )
        })
      }

      const nextPointageId = rolloverResult.data.nextPointageId
      const nextSessionPointageId = rolloverResult.data.nextSessionPointageId
      if (typeof nextPointageId !== 'number' || typeof nextSessionPointageId !== 'number') {
        return
      }

      setWorkEntries([])
      setPauseEntries([])
      setCurrentPointageId(nextPointageId)
      setCurrentSessionPointageId(nextSessionPointageId)
      setCurrentSessionStartedAtIso(
        rolloverResult.data.nextSessionStartedAtIso ?? nextSessionStartIso
      )
      setCurrentWorkEntryId(nextPointageId)
      setCurrentSessionBaseElapsedMs(0)
      setCurrentSessionPauseTotalMs(0)
      setWorkElapsedMs(0)
      setPauseElapsedMs(0)
      setCurrentPausePointageId(null)
      setCurrentPauseStartedAtIso(null)
      setPauseComment('')

      if (pointageModeRef.current === 'paused') {
        if (typeof rolloverResult.data.nextPausePointageId !== 'number') {
          return
        }

        setCurrentPausePointageId(rolloverResult.data.nextPausePointageId)
        setCurrentPauseStartedAtIso(
          rolloverResult.data.nextPauseStartedAtIso ?? nextSessionStartIso
        )
        setPointageMode('paused')
      } else {
        setPointageMode('running')
      }
    } finally {
      midnightTransitionPendingRef.current = false
      setPointageMutationPending(false)
    }
  }, [
    connectedUserId,
    currentPausePointageId,
    currentPauseStartedAtIso,
    currentPointageId,
    currentSessionPauseTotalMs,
    currentSessionStartedAtIso,
    currentWorkEntryId,
    currentWorkEntry,
    workEntries,
    pauseEntries,
    autoValidatePendingDaysBefore,
    postPointageApi,
    registerCompletedPause,
    taskChoice,
    currentTaskTitle,
    getEstimatedServerDateStamp,
    getEstimatedServerNowDate,
    syncServerClock,
  ])

  useEffect(() => {
    if (
      pointageMode === 'idle' ||
      !currentSessionPointageId ||
      !currentSessionStartedAtIso ||
      !taskChoice ||
      pointageMutationPending
    ) {
      return
    }

    const now = getEstimatedServerNowDate()
    const nextMidnight = new Date(now)
    nextMidnight.setHours(24, 0, 0, 0)
    const timeoutMs = Math.max(nextMidnight.getTime() - now.getTime(), 100)

    const timer = window.setTimeout(() => {
      void rolloverActivePointageAtMidnight()
    }, timeoutMs)

    return () => window.clearTimeout(timer)
  }, [
    currentSessionPointageId,
    currentSessionStartedAtIso,
    pointageMode,
    pointageMutationPending,
    rolloverActivePointageAtMidnight,
    taskChoice,
    getEstimatedServerNowDate,
  ])

  useEffect(() => {
    if (
      pointageMode === 'idle' ||
      !currentSessionPointageId ||
      !currentSessionStartedAtIso ||
      !taskChoice ||
      pointageMutationPending
    ) {
      return
    }

    const triggerRolloverCatchUp = () => {
      void (async () => {
        await syncServerClock()
        if (connectedUserId) {
          const didAutoClose = await applyAutoClosureForUser()
          if (didAutoClose) {
            setPointageRefreshKey((previousKey) => previousKey + 1)
            return
          }
          await sendPointageHeartbeat()
        }
        await rolloverActivePointageAtMidnight()
      })()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        triggerRolloverCatchUp()
      }
    }

    window.addEventListener('focus', triggerRolloverCatchUp)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('focus', triggerRolloverCatchUp)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [
    applyAutoClosureForUser,
    connectedUserId,
    currentSessionPointageId,
    currentSessionStartedAtIso,
    pointageMode,
    pointageMutationPending,
    rolloverActivePointageAtMidnight,
    sendPointageHeartbeat,
    syncServerClock,
    taskChoice,
  ])

  useEffect(() => {
    const isPointageViewActive = activeMenu === 'pointer' && activePointagesSubMenu === 'nouveau'
    if (
      !isPointageViewActive ||
      !connectedUserId ||
      pointageMode !== 'idle' ||
      pointageMutationPending
    ) {
      return
    }

    const now = getEstimatedServerNowDate()
    const nextMidnight = new Date(now)
    nextMidnight.setHours(24, 0, 0, 0)
    const timeoutMs = Math.max(nextMidnight.getTime() - now.getTime(), 100)

    const timer = window.setTimeout(() => {
      void (async () => {
        await syncServerClock()
        const currentNow = getEstimatedServerNowDate()
        const yesterdayRef = new Date(currentNow)
        yesterdayRef.setDate(yesterdayRef.getDate() - 1)
        yesterdayRef.setHours(0, 0, 0, 0)
        const yesterdayDateStamp = getLocalDateStamp(yesterdayRef)
        await autoValidatePendingDaysBefore(connectedUserId, yesterdayDateStamp)
        const didAutoValidateYesterday = await autoValidateDayIfNoActiveSession(
          connectedUserId,
          yesterdayDateStamp
        )

        if (didAutoValidateYesterday) {
          setYesterdayPointageSnapshot(null)
          setIsYesterdayAutoValidated(false)
          setPointageDayView('today')
          setPointageRefreshKey((previousKey) => previousKey + 1)
        }
      })()
    }, timeoutMs)

    return () => window.clearTimeout(timer)
  }, [
    activeMenu,
    activePointagesSubMenu,
    autoValidateDayIfNoActiveSession,
    autoValidatePendingDaysBefore,
    connectedUserId,
    getEstimatedServerNowDate,
    pointageMode,
    pointageMutationPending,
    syncServerClock,
  ])

  const beginPointageSession = async (
    selectedTaskId: number,
    resumedEntry: WorkEntry | null,
    freeTaskLabel?: string | null
  ) => {
    setPointageMutationPending(true)
    setPointageStopError('')

    await syncServerClock()
    const pointageDate = getEstimatedServerDateStamp()
    const startResult = await postPointageApi<{
      id_pointage: number | null
      id_session_pointage: number | null
      debut_session_pointage: string | null
      existing_active: boolean
    }>('/api/pointage/start', {
      taskId: selectedTaskId,
      pointageDate,
      freeTaskLabel: normalizeFreeTaskLabel(freeTaskLabel ?? '') || null,
    })

    if (!startResult.ok) {
      setPointageStopError(startResult.error || "Impossible de dÃ©marrer le pointage.")
      setPointageMutationPending(false)
      return
    }

    if (startResult.data.existing_active) {
      setPointageStopError('Un pointage est dÃ©jÃ  en cours.')
      setPointageMutationPending(false)
      return
    }

    const nextPointageId = startResult.data.id_pointage
    const nextSessionId = startResult.data.id_session_pointage
    if (typeof nextPointageId !== 'number' || typeof nextSessionId !== 'number') {
      setPointageStopError("Impossible de dÃ©marrer le pointage.")
      setPointageMutationPending(false)
      return
    }

    const baseElapsedMs = resumedEntry?.totalDurationMs ?? 0
    const resumeComment = resumedEntry ? getLatestWorkComment(resumedEntry) : ''
    const sessionStartIso =
      startResult.data.debut_session_pointage ?? getLocalTimestamp(getEstimatedServerNowDate())

    setCurrentPointageId(nextPointageId)
    setCurrentSessionPointageId(nextSessionId)
    setCurrentPausePointageId(null)
    setCurrentWorkEntryId(nextPointageId)
    setCurrentSessionBaseElapsedMs(baseElapsedMs)
    setCurrentSessionPauseTotalMs(0)
    setCurrentSessionStartedAtIso(sessionStartIso)
    setWorkElapsedMs(baseElapsedMs)
    setPauseElapsedMs(0)
    setPointageComment(resumeComment)
    setPauseComment('')
    setPointageMode('running')
    setPointageMutationPending(false)
  }

  const startPointage = async () => {
    if (!connectedUserId || !taskChoice) {
      return
    }

    const normalizedOtherTaskLabel = normalizeFreeTaskLabel(otherTaskLabel)
    if (isOtherTaskSelected && normalizedOtherTaskLabel === '') {
      setPointageStopError('Veuillez entrer une tÃ¢che avant de lancer le chrono.')
      if (stopErrorTimeoutRef.current !== null) {
        window.clearTimeout(stopErrorTimeoutRef.current)
      }
      stopErrorTimeoutRef.current = window.setTimeout(() => {
        setPointageStopError('')
        stopErrorTimeoutRef.current = null
      }, 6000)
      return
    }

    const selectedTaskId = Number(taskChoice)
    if (Number.isNaN(selectedTaskId)) {
      setPointageStopError("Impossible de dÃ©marrer sans tÃ¢che enregistrable.")
      if (stopErrorTimeoutRef.current !== null) {
        window.clearTimeout(stopErrorTimeoutRef.current)
      }
      stopErrorTimeoutRef.current = window.setTimeout(() => {
        setPointageStopError('')
        stopErrorTimeoutRef.current = null
      }, 6000)
      return
    }

    await syncServerClock()
    const didAutoClose = await applyAutoClosureForUser()
    if (didAutoClose) {
      setPointageRefreshKey((previousKey) => previousKey + 1)
    }

    const activeSnapshot = await getActiveSessionSnapshot()
    if (activeSnapshot && activeSnapshot.sessionId !== currentSessionPointageId) {
      setPointageStopError('Un pointage est dÃ©jÃ  en cours sur votre compte.')
      if (stopErrorTimeoutRef.current !== null) {
        window.clearTimeout(stopErrorTimeoutRef.current)
      }
      stopErrorTimeoutRef.current = window.setTimeout(() => {
        setPointageStopError('')
        stopErrorTimeoutRef.current = null
      }, 6000)
      return
    }

    const pointageDate = getEstimatedServerDateStamp()
    const selectedTaskTitle =
      isOtherTaskSelected
        ? normalizedOtherTaskLabel
        : taskOptions.find((task) => task.id === String(selectedTaskId))?.title || taskLabel
    const existingPointageEntry = await getExistingPointageEntryForToday(
      selectedTaskId,
      selectedTaskTitle,
      pointageDate,
      isOtherTaskSelected ? normalizedOtherTaskLabel : null
    )

    await beginPointageSession(
      selectedTaskId,
      existingPointageEntry,
      isOtherTaskSelected ? normalizedOtherTaskLabel : null
    )
  }

  const pausePointage = async () => {
    if (pointageMutationPending || !currentSessionPointageId) {
      return
    }

    setPointageMutationPending(true)
    setPointageStopError('')
    setPauseComment('')
    await syncServerClock()

    const pauseResult = await postPointageApi<{
      id_pause_pointage: number | null
      debut_pause_pointage: string | null
    }>('/api/pointage/pause', {
      sessionId: currentSessionPointageId,
    })

    if (!pauseResult.ok) {
      setPointageStopError("Impossible de mettre le pointage en pause.")
      setPointageMutationPending(false)
      return
    }

    if (typeof pauseResult.data.id_pause_pointage !== 'number') {
      setPointageStopError("Impossible de mettre le pointage en pause.")
      setPointageMutationPending(false)
      return
    }

    setCurrentPausePointageId(pauseResult.data.id_pause_pointage)
    setCurrentPauseStartedAtIso(pauseResult.data.debut_pause_pointage ?? getLocalTimestamp())
    setPauseElapsedMs(0)
    setPointageMode('paused')
    setPointageMutationPending(false)
  }

  const resumePointage = async () => {
    if (pointageMutationPending || !currentPausePointageId) {
      return
    }

    setPointageMutationPending(true)
    setPointageStopError('')
    await syncServerClock()
    const pauseFinalComment = pauseComment.trim() || null

    const resumeResult = await postPointageApi<{
      fin_pause_pointage: string | null
    }>('/api/pointage/resume', {
      pauseId: currentPausePointageId,
      pauseComment: pauseFinalComment,
    })

    const pauseEndIso = resumeResult.ok
      ? resumeResult.data.fin_pause_pointage ?? getLocalTimestamp()
      : null

    if (!pauseEndIso) {
      setPointageStopError("Impossible de dÃ©marrer le pointage.")
      setPointageMutationPending(false)
      return
    }

    if (currentPauseStartedAtIso) {
      const completedPauseDurationMs = getDurationMsBetween(currentPauseStartedAtIso, pauseEndIso)
      registerCompletedPause(
        currentPausePointageId,
        currentPauseStartedAtIso,
        pauseEndIso,
        pauseFinalComment,
        'ARRET_MANUEL',
        null
      )
      setCurrentSessionPauseTotalMs((previous) => previous + completedPauseDurationMs)
    }

    setCurrentPausePointageId(null)
    setCurrentPauseStartedAtIso(null)
    setPauseComment('')
    setPointageMode('running')
    setPointageMutationPending(false)
  }

  const stopPointage = async () => {
    if (pointageMutationPending || !currentSessionPointageId) {
      return
    }

    setPointageMutationPending(true)
    setPointageStopError('')
    const didClose = await closeCurrentSession(pointageComment.trim() || null, 'ARRET_MANUEL')
    if (!didClose) {
      setPointageStopError((previous) => previous || "Impossible d'arrêter le pointage.")
      setPointageMutationPending(false)
      return
    }
    setPointageMutationPending(false)
  }

  const acknowledgeInactivityAndContinue = () => {
    inactivityLastCheckResponseAtRef.current = Date.now()
    inactivityPromptShownAtRef.current = null
    inactivityReminderSentRef.current = false
    inactivityStopInProgressRef.current = false
    setShowInactivityPrompt(false)
    closeInactivityNotification()
  }

  const stopPointageFromInactivityPrompt = async () => {
    inactivityStopInProgressRef.current = true
    inactivityPromptShownAtRef.current = null
    setShowInactivityPrompt(false)
    closeInactivityNotification()
    if (pointageMutationPending || !currentSessionPointageId) {
      inactivityStopInProgressRef.current = false
      return
    }

    setPointageMutationPending(true)
    setPointageStopError('')
    const didClose = await closeCurrentSession(pointageComment.trim() || null, 'INACTIVITE')
    if (!didClose) {
      setPointageStopError((previous) => previous || "Impossible d'arrêter le pointage.")
      setPointageMutationPending(false)
      inactivityStopInProgressRef.current = false
      return
    }
    setPointageMutationPending(false)
    inactivityStopInProgressRef.current = false
  }

  useEffect(() => {
    if (pointageMode !== 'running') {
      setShowInactivityPrompt(false)
      inactivityLastCheckResponseAtRef.current = null
      inactivityPromptShownAtRef.current = null
      inactivityReminderSentRef.current = false
      inactivityStopInProgressRef.current = false
      closeInactivityNotification()
      return
    }

    if (inactivityLastCheckResponseAtRef.current === null) {
      inactivityLastCheckResponseAtRef.current = Date.now()
    }
    inactivityStopInProgressRef.current = false

    const checkInactivity = window.setInterval(() => {
      if (pointageMutationPending || inactivityStopInProgressRef.current || pointageMode !== 'running') {
        return
      }

      const lastResponseAt = inactivityLastCheckResponseAtRef.current
      if (lastResponseAt === null) {
        return
      }

      const now = Date.now()
      if (!showInactivityPrompt) {
        if (now - lastResponseAt >= INACTIVITY_CHECK_INTERVAL_MS) {
          inactivityPromptShownAtRef.current = now
          inactivityReminderSentRef.current = false
          setShowInactivityPrompt(true)
          playInactivityTone()
          notifyInactivity()
        }
        return
      }

      const promptShownAt = inactivityPromptShownAtRef.current
      if (promptShownAt === null) {
        return
      }

      const elapsedSincePromptMs = now - promptShownAt
      if (
        !inactivityReminderSentRef.current &&
        elapsedSincePromptMs >= INACTIVITY_REMINDER_DELAY_MS
      ) {
        inactivityReminderSentRef.current = true
        playInactivityTone()
        notifyInactivity()
      }

      if (elapsedSincePromptMs >= INACTIVITY_REMINDER_DELAY_MS + INACTIVITY_RESPONSE_WINDOW_MS) {
        void stopPointageFromInactivityPrompt()
      }
    }, 1000)

    return () => {
      window.clearInterval(checkInactivity)
    }
  }, [
    closeInactivityNotification,
    notifyInactivity,
    playInactivityTone,
    pointageMode,
    pointageMutationPending,
    showInactivityPrompt,
  ])

  useEffect(() => {
    if (
      pointageMode !== 'idle' &&
      currentSessionPointageId &&
      typeof window !== 'undefined' &&
      document.visibilityState === 'visible'
    ) {
      void ensureNotificationPermission()
    }
  }, [currentSessionPointageId, ensureNotificationPermission, pointageMode])

  const validatePointage = () => {
    setPointageValidationPreviewDate(
      isYesterdayView && yesterdayPointageSnapshot
        ? yesterdayPointageSnapshot.date
        : getEstimatedServerNowDate()
    )
  }

  const handleConfirmPointageValidation = async () => {
    if (!connectedUserId || !pointageValidationPreviewDate) {
      return
    }

    setPointageMutationPending(true)
    setPointageStopError('')
    await syncServerClock()

    const pointageDate = getLocalDateStamp(pointageValidationPreviewDate)
    const validationResult = await postPointageApi<{ validatedCount: number }>(
      '/api/pointage/validate',
      {
        pointageDate,
      }
    )

    if (!validationResult.ok || validationResult.data.validatedCount <= 0) {
      setPointageStopError(
        validationResult.ok ? 'Aucun pointage Ã  valider.' : 'Impossible de valider le pointage.'
      )
      setPointageMutationPending(false)
      return
    }

    const currentSummaryTasks = pointageReviewSourceSummary.tasks
    const currentSummaryTotalWorkMs = pointageReviewSourceSummary.totalWorkMs
    setAgendaDaySummaries((previousSummaries) => {
      const previousSummary = previousSummaries[pointageDate]
      const mergedTasks = new Map<string, DayTaskSummary>()

      for (const task of previousSummary?.tasks ?? []) {
        mergedTasks.set(task.taskKey, task)
      }

      for (const task of currentSummaryTasks) {
        const existingTask = mergedTasks.get(task.taskKey)
        mergedTasks.set(task.taskKey, {
          taskKey: task.taskKey,
          taskId: task.taskId,
          taskTitle: task.taskTitle,
          comment: task.comment !== '-' ? task.comment : existingTask?.comment ?? '-',
          totalDurationMs: (existingTask?.totalDurationMs ?? 0) + task.totalDurationMs,
        })
      }

      const tasks = Array.from(mergedTasks.values()).sort((a, b) =>
        a.taskTitle.localeCompare(b.taskTitle)
      )

      return {
        ...previousSummaries,
        [pointageDate]: {
          dateStamp: pointageDate,
          tasks,
          totalWorkMs:
            (previousSummary?.totalWorkMs ?? 0) +
            currentSummaryTotalWorkMs,
        },
      }
    })

    if (isYesterdayView) {
      setYesterdayPointageSnapshot(null)
      setIsYesterdayAutoValidated(false)
      setPointageDayView('today')
    } else {
      setWorkEntries([])
      setPauseEntries([])
      setWorkElapsedMs(0)
      setPauseElapsedMs(0)
      setCurrentPointageId(null)
      setCurrentSessionPointageId(null)
      setCurrentPausePointageId(null)
      setCurrentPauseStartedAtIso(null)
      setCurrentWorkEntryId(null)
      setCurrentSessionBaseElapsedMs(0)
      setCurrentSessionPauseTotalMs(0)
      setCurrentSessionStartedAtIso(null)
      setOtherTaskLabel('')
      setPointageComment('')
      setPauseComment('')
      setPointageMode('idle')
    }

    setPointageValidationPreviewDate(null)
    setPointageMutationPending(false)
  }

  const taskLabel =
    currentWorkEntry?.taskTitle ||
    normalizeFreeTaskLabel(otherTaskLabel) ||
    taskOptions.find((task) => task.id === taskChoice)?.title ||
    'TÃ¢che non renseignÃ©e'
  const isOtherTaskSelected = otherTaskOptionId !== null && taskChoice === otherTaskOptionId
  const canValidatePointage =
    (isYesterdayView || pointageMode === 'idle') &&
    viewedWorkEntries.length > 0 &&
    !(isYesterdayView && isYesterdayAutoValidated) &&
    !pointageMutationPending
  const pointageReviewEntries = useMemo(
    () =>
      pointageReviewSourceSummary.tasks.map((task) => ({
        pointageId: task.taskKey,
        taskTitle: task.taskTitle,
        comment: task.comment,
        totalDurationLabel: formatDuration(task.totalDurationMs),
      })),
    [pointageReviewSourceSummary.tasks]
  )
  const isSuiviActivitesActive =
    activeMenu === 'suivi_activites' ||
    activeMenu === 'gestion_taches' ||
    activeMenu === 'gestion_demandes' ||
    activeMenu === 'gestion_pointages'
  const menuLabels: Record<ActiveMenu, string> = {
    accueil: 'Mon agenda',
    pointer: 'Mon pointage',
    taches: 'Mes tÃ¢ches',
    demandes: 'Mes demandes',
    suivi_activites: 'Suivi des activitÃ©s',
    gestion_demandes: 'Gestion des demandes',
    gestion_taches: 'Gestion des tÃ¢ches',
    gestion_pointages: 'Gestion des pointages',
    gestion_bdd: 'Configuration',
  }

  const prepareWorkResume = async (entry: WorkEntry) => {
    if (pointageMode !== 'idle' || pointageMutationPending) {
      return
    }

    setTaskChoice(entry.taskId)
    setOtherTaskLabel(otherTaskOptionId !== null && entry.taskId === otherTaskOptionId ? entry.taskTitle : '')
    const selectedTaskId = Number(entry.taskId)
    if (Number.isNaN(selectedTaskId)) {
      setPointageStopError("Impossible de relancer sans tÃ¢che enregistrable.")
      return
    }

    const activeSnapshot = await getActiveSessionSnapshot()
    if (activeSnapshot && activeSnapshot.sessionId !== currentSessionPointageId) {
      setPointageStopError('Un pointage est dÃ©jÃ  en cours sur votre compte.')
      return
    }

    await beginPointageSession(
      selectedTaskId,
      entry,
      otherTaskOptionId !== null && entry.taskId === otherTaskOptionId ? entry.taskTitle : null
    )
  }

  const handleLogout = async () => {
    if (pointageMode !== 'idle' && currentSessionPointageId && !pointageMutationPending) {
      setPointageMutationPending(true)
      const didClose = await closeCurrentSession(pointageComment.trim() || null, 'ARRET_AUTO')
      setPointageMutationPending(false)
      if (!didClose) {
        setPointageStopError("Impossible d'arrÃªter automatiquement le pointage.")
        return
      }
    }

    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
      })
    } catch {
      // If logout API fails, local cleanup and redirect still happen.
    }

    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(CONNECTED_USERNAME_STORAGE_KEY)
      window.dispatchEvent(new Event(CONNECTED_USERNAME_CHANGED_EVENT))
    }

    router.push('/')
  }

  return (
    <>
      <AppShell
        connectedUsername={connectedUsername}
        userRole={connectedUserRole}
        activeTab={activeTab}
        activeMenu={activeMenu}
        activeDemandesSubMenu={activeDemandesSubMenu}
        activeConfigurationSubMenu={activeConfigurationSubMenu}
        activeConfigurationTab={activeConfigurationTab}
        onTabChange={(nextTab) => {
          if (nextTab === 'tab2') {
            router.push('/utilisateurs')
            return
          }
          setActiveTab(nextTab)
        }}
        onOpenAgenda={() => {
          openAgendaPage('semaine')
          resetToToday()
        }}
        onOpenPointage={openPointagePage}
        onOpenMenu={openShellPage}
        onConfigurationSubMenuChange={setActiveConfigurationSubMenu}
        onConfigurationTabChange={setActiveConfigurationTab}
        onLogout={handleLogout}
        middleContent={
          activeTab === 'tab1' && activeMenu === 'pointer' ? (
            <div className={styles.agendaTabStrip} role="tablist" aria-label="Vue pointage">
              <button
                type="button"
                role="tab"
                aria-selected={activePointagesSubMenu === 'nouveau'}
                className={`${styles.tabButton} ${
                  activePointagesSubMenu === 'nouveau' ? styles.tabButtonActive : ''
                }`}
                onClick={() => setActivePointagesSubMenu('nouveau')}
              >
                Nouveau pointage
              </button>
            </div>
          ) : activeTab === 'tab1' &&
            activeMenu === 'gestion_bdd' &&
            activeConfigurationSubMenu === 'taches' ? (
            <div className={styles.agendaTabStrip} role="tablist" aria-label="Vue configuration">
              <button
                type="button"
                role="tab"
                aria-selected={activeConfigurationTab === 'donnees'}
                className={`${styles.tabButton} ${
                  activeConfigurationTab === 'donnees' ? styles.tabButtonActive : ''
                }`}
                onClick={() => setActiveConfigurationTab('donnees')}
              >
                DonnÃ©es
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeConfigurationTab === 'historique'}
                className={`${styles.tabButton} ${
                  activeConfigurationTab === 'historique' ? styles.tabButtonActive : ''
                }`}
                onClick={() => setActiveConfigurationTab('historique')}
              >
                Historique
              </button>
            </div>
          ) : null
        }
      >
        {activeTab === 'tab1' &&
        activeMenu === 'pointer' &&
        activePointagesSubMenu === 'nouveau' ? (
            <div className={styles.pointageLayout}>
              {yesterdayPointageSnapshot ? (
                <div className={styles.pointageDaySwitch} role="tablist" aria-label="Jour de pointage">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={pointageDayView === 'yesterday'}
                    className={`${styles.tabButton} ${
                      pointageDayView === 'yesterday' ? styles.tabButtonActive : ''
                    }`}
                    onClick={() => setPointageDayView('yesterday')}
                  >
                    {`Hier - ${yesterdayLabel}`}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={pointageDayView === 'today'}
                    className={`${styles.tabButton} ${
                      pointageDayView === 'today' ? styles.tabButtonActive : ''
                    }`}
                    onClick={() => setPointageDayView('today')}
                  >
                    {`Aujourd'hui - ${todayLabel}`}
                  </button>
                </div>
              ) : null}
              <div className={styles.pointageTopPane}>
                <div className={`${styles.statsCard} ${styles.statsCardWork}`}>
                  <div className={styles.statsCardTitle}>TEMPS DE TRAVAIL</div>
                  <div className={styles.statsCardValue}>
                    <span>{formatDurationParts(isYesterdayView ? viewedWorkTotalMs : displayedTotalWorkMs).hours}</span>
                    <span className={styles.statsUnit}>H</span>
                    <span className={styles.statsSep}> - </span>
                    <span>{formatDurationParts(isYesterdayView ? viewedWorkTotalMs : displayedTotalWorkMs).minutes}</span>
                    <span className={styles.statsUnit}>MIN</span>
                    <span className={styles.statsSep}> - </span>
                    <span>{formatDurationParts(isYesterdayView ? viewedWorkTotalMs : displayedTotalWorkMs).seconds}</span>
                    <span className={styles.statsUnit}>SEC</span>
                  </div>
                </div>
                <div className={`${styles.statsCard} ${styles.statsCardPause}`}>
                  <div className={styles.statsCardTitle}>TEMPS DE PAUSE</div>
                  <div className={styles.statsCardValue}>
                    <span>{formatDurationParts(isYesterdayView ? viewedPauseTotalMs : displayedTotalPauseMs).hours}</span>
                    <span className={styles.statsUnit}>H</span>
                    <span className={styles.statsSep}> - </span>
                    <span>{formatDurationParts(isYesterdayView ? viewedPauseTotalMs : displayedTotalPauseMs).minutes}</span>
                    <span className={styles.statsUnit}>MIN</span>
                    <span className={styles.statsSep}> - </span>
                    <span>{formatDurationParts(isYesterdayView ? viewedPauseTotalMs : displayedTotalPauseMs).seconds}</span>
                    <span className={styles.statsUnit}>SEC</span>
                  </div>
                </div>
                <button
                  type="button"
                  className={styles.pointageValidateBtn}
                  disabled={!canValidatePointage}
                  onClick={validatePointage}
                >
                  Valider le pointage
                </button>
              </div>
              <div
                className={`${styles.pointageBottomPane} ${
                  isYesterdayView ? styles.pointageBottomPaneYesterday : ''
                }`}
              >
                <div className={styles.pointageBottomScroll}>
                  {!isYesterdayView ? (
                    <div
                      className={`${styles.pointageWrap} ${
                        pointageMode === 'idle' ? styles.pointageWrapIdle : styles.pointageWrapActive
                      }`}
                    >
                    <div className={styles.pointageRowShell}>
                      <div
                        className={`${styles.pointageRow} ${
                          pointageMode === 'idle'
                            ? styles.pointageRowIdle
                            : styles.pointageRowActive
                        }`}
                      >
                        {pointageMode === 'idle' ? (
                          <>
                            <select
                              className={styles.pointageSelect}
                              aria-label={'Type de t\u00e2che'}
                              value={taskChoice}
                              onChange={(event) => setTaskChoice(event.target.value)}
                              disabled={taskLoading || taskOptions.length === 0}
                            >
                              {taskChoice ? null : (
                                <option value="" disabled>
                                  {taskLoading
                                    ? 'Chargement des t\u00e2ches...'
                                    : taskLoadError || 'Aucune t\u00e2che attribu\u00e9e.'}
                                </option>
                              )}
                            {taskOptions.map((task) => (
                                <option key={task.id} value={task.id}>
                                  {task.title}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : (
                          <div className={styles.pointageTextZone}>{taskLabel}</div>
                        )}
                        <div className={styles.pointageTimer}>{formatDuration(workElapsedMs)}</div>
                        {pointageMode === 'idle' ? (
                          <button
                            type="button"
                            className={`${styles.pointageActionBtn} ${styles.pointageStartBtn}`}
                            onClick={startPointage}
                            disabled={!taskChoice || taskLoading}
                          >
                            {'D\u00c9MARRER'}
                          </button>
                        ) : pointageMode === 'running' ? (
                          <>
                            <button
                              type="button"
                              className={`${styles.pointageActionBtn} ${styles.pointagePauseResumeBtn}`}
                              onClick={pausePointage}
                              disabled={pointageMutationPending}
                            >
                              Pause
                            </button>
                            <button
                              type="button"
                              className={styles.pointageStopBtn}
                              onClick={stopPointage}
                              disabled={pointageMutationPending}
                            >
                              {'Arr\u00eater'}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={`${styles.pointageActionBtn} ${styles.pointagePauseResumeBtn}`}
                              onClick={resumePointage}
                              disabled={pointageMutationPending}
                            >
                              Reprendre
                            </button>
                            <button
                              type="button"
                              className={styles.pointageStopBtn}
                              onClick={stopPointage}
                              disabled={pointageMutationPending}
                            >
                              {'Arr\u00eater'}
                            </button>
                          </>
                        )}

                        {pointageMode === 'idle' && isOtherTaskSelected ? (
                          <input
                            type="text"
                            className={styles.pointageCustomTaskField}
                            aria-label={'Libell\u00e9 de la t\u00e2che libre'}
                            placeholder={'ajouter votre t\u00e2che'}
                            value={otherTaskLabel}
                            onChange={(event) => setOtherTaskLabel(event.target.value)}
                            disabled={taskLoading || pointageMutationPending}
                          />
                        ) : null}

                        {pointageMode !== 'idle' ? (
                          <textarea
                            className={styles.pointageCommentField}
                            aria-label="Commentaire du pointage"
                            placeholder="ajouter commentaire"
                            value={pointageComment}
                            onChange={(event) => setPointageComment(event.target.value)}
                            rows={3}
                          />
                        ) : null}
                        {pointageStopError ? (
                          <p className={styles.pointageInlineError}>{pointageStopError}</p>
                        ) : null}
                      </div>
                      {pointageMode !== 'idle' ? (
                        <span
                          className={`${styles.pointageRowIndicator} ${styles.pointageRowIndicatorWork}`}
                          aria-hidden="true"
                        >
                          TRAVAIL
                        </span>
                      ) : null}
                    </div>

                    {pointageMode === 'paused' ? (
                      <div className={`${styles.pointageRowShell} ${styles.pointageRowPauseShell}`}>
                        <div className={`${styles.pointageRow} ${styles.pointageRowPause}`}>
                          <textarea
                            className={styles.pointagePauseCommentField}
                            aria-label="Commentaire de pause"
                            placeholder="ajouter commentaire"
                            value={pauseComment}
                            onChange={(event) => setPauseComment(event.target.value)}
                            rows={2}
                          />
                          <div className={styles.pointageTimer}>{formatDuration(pauseElapsedMs)}</div>
                        </div>
                        <span
                          className={`${styles.pointageRowIndicator} ${styles.pointageRowIndicatorPause}`}
                          aria-hidden="true"
                        >
                          PAUSE
                        </span>
                      </div>
                    ) : null}
                    </div>
                  ) : null}
                  {isYesterdayView && isYesterdayAutoValidated ? (
                    <div className={styles.pointageAutoValidatedNotice}>
                      Pointage validé automatiquement au passage de minuit
                    </div>
                  ) : null}
                  {viewedWorkEntries.length > 0 ? (
                    <div className={styles.workHistoryOuter}>
                      <section className={styles.workHistoryBlock} aria-label="Mes travaux">
                        <div className={styles.workHistoryHeader}>
                          <h2 className={styles.workHistoryTitle}>MES TRAVAUX</h2>
                          <div className={styles.workHistoryTotal}>
                            {formatDuration(isYesterdayView ? viewedWorkTotalMs : displayedTotalWorkMs)}
                          </div>
                        </div>
                        <div className={styles.workHistoryBody}>
                          {viewedWorkEntries.map((entry) => {
                            const latestComment = getLatestWorkComment(entry)
                            const latestStopReason = getLatestWorkStopReason(entry)
                            const latestCommentDisplay = buildCommentDisplayParts(
                              latestComment,
                              latestStopReason.code,
                              latestStopReason.label
                            )
                            const isEntryLocked =
                              currentWorkEntryId === entry.pointageId

                            return (
                              <div
                                key={entry.pointageId}
                                className={`${styles.workHistoryRow} ${
                                  isEntryLocked ? styles.workHistoryRowMuted : ''
                                }`}
                              >
                                <div className={styles.workHistoryTask}>{entry.taskTitle}</div>
                                <div className={styles.workHistoryTimes}>
                                  {entry.sessions.map((session) => (
                                    <div
                                      key={session.sessionId}
                                      className={styles.workHistoryTimeRange}
                                    >
                                      {formatTimeLabel(session.startIso)} -{' '}
                                      {formatTimeLabel(session.endIso)}
                                    </div>
                                  ))}
                                </div>
                                <div className={styles.workHistoryDuration}>
                                  {formatDuration(entry.totalDurationMs)}
                                </div>
                                <div className={styles.workHistoryComment}>
                                  {latestCommentDisplay.text || null}
                                  {latestCommentDisplay.alertLabel ? (
                                    <>
                                      <br />
                                      <span className={styles.stopReasonAlert}>
                                        {`(${latestCommentDisplay.alertLabel})`}
                                      </span>
                                    </>
                                  ) : null}
                                </div>
                                <div className={styles.workHistoryActions}>
                                  <button
                                    type="button"
                                    className={styles.workHistoryIconBtn}
                                    aria-label={`Relancer ${entry.taskTitle}`}
                                    title={'Relancer cette t\u00e2che'}
                                    onClick={() => prepareWorkResume(entry)}
                                    disabled={
                                      isYesterdayView ||
                                      isEntryLocked ||
                                      pointageMode !== 'idle' ||
                                      pointageMutationPending
                                    }
                                  >
                                    {'\u25b6'}
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </section>
                    </div>
                  ) : null}
                  {viewedPauseEntries.length > 0 ? (
                    <div className={styles.pauseHistoryOuter}>
                      <section className={styles.pauseHistoryBlock} aria-label="Mes pauses">
                        <div className={styles.pauseHistoryHeader}>
                          <h2 className={styles.pauseHistoryTitle}>MES PAUSES</h2>
                          <div className={styles.pauseHistoryTotal}>
                            {formatDuration(isYesterdayView ? viewedPauseTotalMs : displayedTotalPauseMs)}
                          </div>
                        </div>
                        <div className={styles.pauseHistoryBody}>
                          {viewedPauseEntries.map((entry) => {
                            const isPauseEntryLocked =
                              pointageMode === 'paused' &&
                              currentPausePointageId !== null &&
                              entry.taskId === (currentWorkEntry?.taskId ?? taskChoice)

                            return (
                              <div
                                key={entry.taskId}
                                className={`${styles.pauseHistoryRow} ${
                                  isPauseEntryLocked ? styles.pauseHistoryRowMuted : ''
                                }`}
                              >
                                <div className={styles.pauseHistoryTask}>
                                  {`Pause \u2022 ${entry.taskTitle}`}
                                </div>
                                <div className={styles.pauseHistoryTimes}>
                                  {entry.pauses.map((pause) => (
                                    <div key={pause.pauseId} className={styles.pauseHistoryTimeRange}>
                                      {(() => {
                                        const pauseComment = pause.comment?.trim() ?? ''
                                        const pauseStopReasonLabel = getNonManualStopReasonLabel(
                                          pause.stopReasonCode,
                                          pause.stopReasonLabel
                                        )

                                        return (
                                          <>
                                            {formatTimeLabel(pause.startIso)} - {formatTimeLabel(pause.endIso)}
                                            {pauseComment ? ` (${pauseComment})` : ''}
                                            {pauseStopReasonLabel ? (
                                              <>
                                                <br />
                                                <span className={styles.stopReasonAlert}>
                                                  {`(${pauseStopReasonLabel})`}
                                                </span>
                                              </>
                                            ) : null}
                                          </>
                                        )
                                      })()}
                                    </div>
                                  ))}
                                </div>
                                <div className={styles.pauseHistoryDuration}>
                                  {formatDuration(entry.totalDurationMs)}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </section>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className={styles.zoneLabel}>
              {activeMenu === 'gestion_bdd'
                ? activeConfigurationTab === 'donnees'
                  ? 'DonnÃ©es' : 'Historique'
                : menuLabels[activeMenu]}
            </div>
          )}
      </AppShell>
      {monthDetailDate ? (
        <div className={styles.monthDetailOverlay} onClick={() => setMonthDetailDate(null)}>
          <div
            className={styles.monthDetailPanel}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="DÃ©tail de la journÃ©e"
          >
            <div className={styles.monthDetailHeaderRow}>
              <article className={styles.monthDetailMainCard}>
                <p className={styles.dayName}>
                  {monthDetailDate.toLocaleDateString('fr-FR', {
                    weekday: 'long',
                  })}{' '}
                  -{' '}
                  {monthDetailDate.toLocaleDateString('fr-FR', {
                    day: '2-digit',
                    month: '2-digit',
                    year: '2-digit',
                  })}
                </p>
              </article>
              <button
                type="button"
                className={styles.monthDetailClose}
                aria-label="Fermer le dÃ©tail"
                onClick={() => setMonthDetailDate(null)}
              >
                &times;
              </button>
            </div>
            <article className={styles.monthDetailEmptyCard}>
              {monthDetailSummary ? (
                <div className={styles.monthDetailSummaryWrap}>
                  <div className={styles.monthDetailSummaryTotal}>
                    {formatDuration(monthDetailSummary.totalWorkMs)}
                  </div>
                  <div className={styles.pointageReviewEntries}>
                    {monthDetailSummary.tasks.map((task) => (
                      <article
                        key={task.taskKey}
                        className={styles.pointageReviewTaskCard}
                        aria-label={`SynthÃ¨se de ${task.taskTitle}`}
                      >
                        <h3 className={styles.pointageReviewTaskTitle}>{task.taskTitle}</h3>
                        {task.comment !== '-' ? (
                          <div className={styles.pointageReviewTaskComment}>
                            {splitCommentLines(task.comment).map((line, index) => (
                              <div key={`${task.taskKey}-review-comment-${index}`} className={styles.commentLine}>
                                <span className={styles.commentMarker}>&gt;</span> {line}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div className={styles.pointageReviewTaskDuration}>
                          {formatDuration(task.totalDurationMs)}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}
            </article>
          </div>
        </div>
      ) : null}
      {pointageValidationPreviewDate ? (
        <div className={styles.monthDetailOverlay} onClick={() => setPointageValidationPreviewDate(null)}>
          <div
            className={styles.monthDetailPanel}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Validation du pointage"
          >
            <div className={styles.monthDetailHeaderRow}>
              <article className={styles.monthDetailMainCard}>
                <p className={styles.dayName}>
                  {capitalizeFirstLetter(pointageValidationPreviewDate.toLocaleDateString('fr-FR', {
                    weekday: 'long',
                  }))}{' '}
                  -{' '}
                  {pointageValidationPreviewDate.toLocaleDateString('fr-FR', {
                    day: '2-digit',
                    month: '2-digit',
                    year: '2-digit',
                  })}
                </p>
              </article>
              <button
                type="button"
                className={styles.monthDetailClose}
                aria-label="Fermer la validation du pointage"
                onClick={() => setPointageValidationPreviewDate(null)}
              >
                &times;
              </button>
            </div>
            <article className={`${styles.monthDetailEmptyCard} ${styles.pointageReviewMonthLikeScroll}`}>
              <div className={styles.monthDetailSummaryWrap}>
                <div
                  className={`${styles.monthDetailSummaryTotal} ${
                    expectedDailyDurationMs !== null
                      ? isValidationDailyTargetReached
                        ? styles.monthDetailSummaryTotalReached
                        : styles.monthDetailSummaryTotalMissed
                      : ''
                  }`}
                >
                  {formatDuration(isYesterdayView ? viewedWorkTotalMs : displayedTotalWorkMs)}
                </div>
                <div className={`${styles.pointageReviewEntries} ${styles.monthDetailEntries}`}>
                  {pointageReviewEntries.map((entry) => (
                    <article
                      key={entry.pointageId}
                      className={`${styles.pointageReviewTaskCard} ${styles.monthDetailTaskCard}`}
                      aria-label={`SynthÃ¨se de ${entry.taskTitle}`}
                    >
                      <h3 className={styles.pointageReviewTaskTitle}>{entry.taskTitle}</h3>
                      {entry.comment !== '-' ? (
                        <div className={styles.pointageReviewTaskComment}>
                          {splitCommentLines(entry.comment).map((line, index) => (
                            <div key={`${entry.pointageId}-comment-${index}`} className={styles.commentLine}>
                              <span className={styles.commentMarker}>&gt;</span> {line}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <div className={styles.pointageReviewTaskDuration}>{entry.totalDurationLabel}</div>
                    </article>
                  ))}
                </div>
              </div>
            </article>
            <button
              type="button"
              className={styles.pointageReviewValidateBtn}
              aria-label="Valider le pointage"
              onClick={handleConfirmPointageValidation}
            >
              Valider
            </button>
          </div>
        </div>
      ) : null}
      {showInactivityPrompt && pointageMode === 'running' ? (
        <div className={styles.inactivityToast} role="dialog" aria-live="assertive" aria-label="Alerte d'inactivité">
          <div className={styles.inactivityToastHeader}>Jarvis Time</div>
          <div className={styles.inactivityToastBody}>
            <p className={styles.inactivityToastMessage}>
              {`Toujours en activité${connectedUsername ? ` ${connectedUsername}` : ''} ? Répondez sous 5 minutes.`}
            </p>
            <button
              type="button"
              className={`${styles.inactivityActionBtn} ${styles.inactivityContinueBtn}`}
              onClick={acknowledgeInactivityAndContinue}
            >
              CONTINUER LE POINTAGE
            </button>
            <button
              type="button"
              className={`${styles.inactivityActionBtn} ${styles.inactivityStopBtn}`}
              onClick={() => {
                void stopPointageFromInactivityPrompt()
              }}
            >
              ARRÊTER LE POINTAGE
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}



