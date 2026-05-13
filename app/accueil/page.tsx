'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import styles from './page.module.css'

const UI_STATE_STORAGE_KEY = 'app_pointer_accueil_ui_state'
const CONNECTED_USERNAME_STORAGE_KEY = 'app_pointer_connected_username'
const OTHER_ACTIVITY_TASK_ID = '__other_activity__'
const UI_STATE_CHANGED_EVENT = 'app_pointer_ui_state_changed'

type WorkSessionEntry = {
  sessionId: number
  startIso: string
  endIso: string
  durationMs: number
  comment: string | null
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
}

type PauseEntry = {
  taskId: string
  taskTitle: string
  totalDurationMs: number
  pauses: PauseSegmentEntry[]
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
const AGENDA_HOURS = Array.from({ length: 17 }, (_, index) => `${index + 6}h`)
const LOCAL_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/

function padTimeUnit(value: number) {
  return String(value).padStart(2, '0')
}

function getLocalDateStamp(referenceDate: Date = new Date()) {
  return `${referenceDate.getFullYear()}-${padTimeUnit(referenceDate.getMonth() + 1)}-${padTimeUnit(referenceDate.getDate())}`
}

function getLocalTimestamp(referenceDate: Date = new Date()) {
  return `${getLocalDateStamp(referenceDate)}T${padTimeUnit(referenceDate.getHours())}:${padTimeUnit(referenceDate.getMinutes())}:${padTimeUnit(referenceDate.getSeconds())}.${String(referenceDate.getMilliseconds()).padStart(3, '0')}`
}

function parseStoredTimestamp(timestamp: string) {
  const normalizedTimestamp = timestamp.trim()
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(normalizedTimestamp)) {
    return new Date(normalizedTimestamp)
  }

  const match = normalizedTimestamp.match(LOCAL_TIMESTAMP_PATTERN)
  if (!match) {
    return new Date(normalizedTimestamp)
  }

  const [, year, month, day, hours, minutes, seconds = '0', fraction = '0'] = match
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
    Number((fraction + '000').slice(0, 3))
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
  return (
    [...entry.sessions]
      .reverse()
      .find((session) => session.comment && session.comment.trim() !== '')?.comment ?? ''
  )
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

  window.addEventListener('storage', handleStorage)
  return () => window.removeEventListener('storage', handleStorage)
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
  const [taskOptions, setTaskOptions] = useState<Array<{ id: string; title: string }>>([])
  const [taskChoice, setTaskChoice] = useState('')
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
  const [connectedUserId, setConnectedUserId] = useState<number | null>(null)
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
  const [pointageMutationPending, setPointageMutationPending] = useState(false)
  const stopErrorTimeoutRef = useRef<number | null>(null)
  const connectedUsername = useSyncExternalStore(
    subscribeToUsernameStorage,
    readStoredUsername,
    () => ''
  )

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
        }
        return
      }

      setTaskLoading(true)
      setTaskLoadError('')
      const fallbackTaskOption = [{ id: OTHER_ACTIVITY_TASK_ID, title: 'Autre activité' }]

      const { data: userData, error: userError } = await supabase
        .from('utilisateur')
        .select('id_utilisateur')
        .eq('username_utilisateur', connectedUsername)
        .eq('actif', true)
        .single()

      if (userError || !userData) {
        setConnectedUserId(null)
        setTaskOptions(fallbackTaskOption)
        setTaskChoice(OTHER_ACTIVITY_TASK_ID)
        setTaskLoadError('Impossible de charger les tâches.')
        setTaskLoading(false)
        return
      }

      setConnectedUserId(userData.id_utilisateur)

      const { data: assignedTasksData, error: assignedTasksError } = await supabase
        .from('utilisateur_tache')
        .select('id_tache')
        .eq('id_utilisateur', userData.id_utilisateur)

      if (assignedTasksError || !assignedTasksData) {
        setTaskOptions(fallbackTaskOption)
        setTaskChoice(OTHER_ACTIVITY_TASK_ID)
        setTaskLoadError('Impossible de charger les tâches.')
        setTaskLoading(false)
        return
      }

      const { data: otherActivityTaskData } = await supabase
        .from('tache')
        .select('id_tache, titre_tache')
        .eq('titre_tache', 'Autre activité')
        .eq('actif', true)
        .maybeSingle()

      const otherActivityOption = otherActivityTaskData
        ? [{ id: String(otherActivityTaskData.id_tache), title: otherActivityTaskData.titre_tache }]
        : fallbackTaskOption

      const taskIds = assignedTasksData.map((taskLink) => taskLink.id_tache)

      if (taskIds.length === 0) {
        setTaskOptions(otherActivityOption)
        setTaskChoice(otherActivityOption[0]?.id ?? '')
        setTaskLoading(false)
        return
      }

      const { data: tasksData, error: tasksError } = await supabase
        .from('tache')
        .select('id_tache, titre_tache')
        .in('id_tache', taskIds)
        .eq('actif', true)
        .order('titre_tache', { ascending: true })

      if (tasksError || !tasksData) {
        setTaskOptions(fallbackTaskOption)
        setTaskChoice(OTHER_ACTIVITY_TASK_ID)
        setTaskLoadError('Impossible de charger les tâches.')
        setTaskLoading(false)
        return
      }

      const nextTaskOptions = tasksData.map((task) => ({
        id: String(task.id_tache),
        title: task.titre_tache,
      }))
      const hasOtherActivityAlready = nextTaskOptions.some(
        (task) => task.title.toLowerCase() === 'autre activité'
      )
      if (!hasOtherActivityAlready) {
        nextTaskOptions.push(...otherActivityOption)
      }

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
      const pointageDate = getLocalDateStamp()
      const { data: userData, error: userError } = await supabase
        .from('utilisateur')
        .select('id_utilisateur')
        .eq('username_utilisateur', connectedUsername)
        .eq('actif', true)
        .single()

      if (cancelled || userError || !userData) {
        return
      }

      const userId = userData.id_utilisateur
      setConnectedUserId(userId)

      const { data: pointageRows, error: pointageError } = await supabase
        .from('pointage')
        .select('id_pointage, id_tache')
        .eq('id_utilisateur_pointeur', userId)
        .eq('date_pointage', pointageDate)
        .order('id_pointage', { ascending: true })

      if (cancelled || pointageError || !pointageRows || pointageRows.length === 0) {
        if (!cancelled) {
          setWorkEntries([])
          setPauseEntries([])
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
            'id_session_pointage, id_pointage, debut_session_pointage, fin_session_pointage, commentaire_session_pointage'
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
      const pointageToTaskId = new Map<number, number>(
        pointageRows.map((row) => [row.id_pointage, row.id_tache])
      )
      const pointageToCanonicalByTask = new Map<number, number>()
      for (const row of pointageRows) {
        if (!pointageToCanonicalByTask.has(row.id_tache)) {
          pointageToCanonicalByTask.set(row.id_tache, row.id_pointage)
        }
      }

      const workByTaskId = new Map<number, WorkEntry>()
      let activeSession:
        | {
            id_session_pointage: number
            id_pointage: number
            debut_session_pointage: string
            fin_session_pointage: string | null
            commentaire_session_pointage: string | null
          }
        | null = null

      for (const session of sessionRows) {
        const taskId = pointageToTaskId.get(session.id_pointage)
        if (!taskId) {
          continue
        }

        const canonicalPointageId = pointageToCanonicalByTask.get(taskId) ?? session.id_pointage
        const taskTitle = taskTitleById.get(taskId) ?? 'Tâche non renseignée'

        if (!workByTaskId.has(taskId)) {
          workByTaskId.set(taskId, {
            pointageId: canonicalPointageId,
            taskId: String(taskId),
            taskTitle,
            totalDurationMs: 0,
            sessions: [],
          })
        }

        if (session.fin_session_pointage) {
          const durationMs = getDurationMsBetween(
            session.debut_session_pointage,
            session.fin_session_pointage
          )
          const entry = workByTaskId.get(taskId) as WorkEntry
          entry.sessions.push({
            sessionId: session.id_session_pointage,
            startIso: session.debut_session_pointage,
            endIso: session.fin_session_pointage,
            durationMs,
            comment: session.commentaire_session_pointage,
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
                'id_pause_pointage, id_session_pointage, debut_pause_pointage, fin_pause_pointage, commentaire_pause_pointage'
              )
              .in('id_session_pointage', sessionIds)
              .order('debut_pause_pointage', { ascending: true })
          : { data: [] }

      const sessionById = new Map<number, (typeof sessionRows)[number]>(
        sessionRows.map((session) => [session.id_session_pointage, session])
      )
      const pauseByTaskId = new Map<number, PauseEntry>()
      let activePause:
        | {
            id_pause_pointage: number
            id_session_pointage: number
            debut_pause_pointage: string
            fin_pause_pointage: string | null
            commentaire_pause_pointage: string | null
          }
        | null = null

      for (const pause of pauseRows ?? []) {
        const sourceSession = sessionById.get(pause.id_session_pointage)
        if (!sourceSession) {
          continue
        }
        const taskId = pointageToTaskId.get(sourceSession.id_pointage)
        if (!taskId) {
          continue
        }
        const taskTitle = taskTitleById.get(taskId) ?? 'Tâche non renseignée'
        if (!pauseByTaskId.has(taskId)) {
          pauseByTaskId.set(taskId, {
            taskId: String(taskId),
            taskTitle,
            totalDurationMs: 0,
            pauses: [],
          })
        }

        if (pause.fin_pause_pointage) {
          const durationMs = getDurationMsBetween(
            pause.debut_pause_pointage,
            pause.fin_pause_pointage
          )
          const entry = pauseByTaskId.get(taskId) as PauseEntry
          entry.pauses.push({
            pauseId: pause.id_pause_pointage,
            startIso: pause.debut_pause_pointage,
            endIso: pause.fin_pause_pointage,
            durationMs,
            comment: pause.commentaire_pause_pointage,
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

      const activeTaskId = pointageToTaskId.get(activeSession.id_pointage)
      if (!activeTaskId) {
        setPointageMode('idle')
        setWorkElapsedMs(0)
        setPauseElapsedMs(0)
        setCurrentSessionPauseTotalMs(0)
        return
      }
      const activeTaskIdAsString = String(activeTaskId)
      const activeWorkEntry =
        workEntriesFromDb.find((entry) => entry.taskId === activeTaskIdAsString) ?? null
      const baseWorkMs = activeWorkEntry?.totalDurationMs ?? 0

      const completedPauseMsForActiveSession =
        completedPauseMsBySessionId.get(activeSession.id_session_pointage) ?? 0

      const activePauseElapsedMs =
        activePause?.fin_pause_pointage
          ? 0
          : Math.max(
              Date.now() -
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
              Date.now() - parseStoredTimestamp(activeSession.debut_session_pointage).getTime() - completedPauseMsForActiveSession,
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
      setPointageComment(
        activeSession.commentaire_session_pointage ??
          (activeWorkEntry ? getLatestWorkComment(activeWorkEntry) : '')
      )

      if (activePause && !activePause.fin_pause_pointage) {
        setCurrentPausePointageId(activePause.id_pause_pointage)
        setCurrentPauseStartedAtIso(activePause.debut_pause_pointage)
        setPauseElapsedMs(activePauseElapsedMs)
        setPauseComment(activePause.commentaire_pause_pointage ?? '')
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
  }, [activeMenu, activePointagesSubMenu, connectedUsername])

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
        Date.now() -
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
    pointageMode,
  ])

  useEffect(() => {
    if (pointageMode !== 'paused' || !currentPauseStartedAtIso || !currentSessionStartedAtIso) return

    const syncPausedState = () => {
      setPauseElapsedMs(
        Math.max(Date.now() - parseStoredTimestamp(currentPauseStartedAtIso).getTime(), 0)
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
    taskOptions.find((task) => task.id === taskChoice)?.title ||
    'Tâche non renseignée'
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

  const buildWorkEntryFromSessions = (
    pointageId: number,
    taskId: string,
    taskTitle: string,
    sessions: Array<{
      id_session_pointage: number
      debut_session_pointage: string
      fin_session_pointage: string | null
      commentaire_session_pointage: string | null
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
          comment: session.commentaire_session_pointage,
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

  const getExistingPointageEntryForToday = async (
    selectedTaskId: number,
    taskTitle: string,
    pointageDate: string
  ) => {
    const existingLocalEntry = workEntries.find((entry) => entry.taskId === String(selectedTaskId))
    if (existingLocalEntry) {
      return existingLocalEntry
    }

    if (!connectedUserId) {
      return null
    }

    const { data: pointageRows, error: pointageLookupError } = await supabase
      .from('pointage')
      .select('id_pointage')
      .eq('id_utilisateur_pointeur', connectedUserId)
      .eq('id_tache', selectedTaskId)
      .eq('date_pointage', pointageDate)
      .order('id_pointage', { ascending: true })

    if (pointageLookupError || !pointageRows || pointageRows.length === 0) {
      return null
    }

    const canonicalPointageId = pointageRows[0].id_pointage
    const pointageIds = pointageRows.map((row) => row.id_pointage)
    const existingEntry = workEntries.find((entry) => entry.pointageId === canonicalPointageId)
    if (existingEntry) {
      return existingEntry
    }

    const { data: sessionRows, error: sessionLookupError } = await supabase
      .from('session_pointage')
      .select(
        'id_session_pointage, debut_session_pointage, fin_session_pointage, commentaire_session_pointage'
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
      taskTitle,
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

  const registerCompletedPause = (
    pauseId: number,
    startIso: string,
    endIso: string,
    comment: string | null
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
  }

  const closeCurrentSession = async (sessionEndIso: string, sessionComment: string | null) => {
    if (!currentSessionPointageId) {
      return false
    }

    if (pointageMode === 'paused' && currentPausePointageId) {
      const pauseFinalComment = pauseComment.trim() || null
      const { error: pauseUpdateError } = await supabase
        .from('pause_pointage')
        .update({
          fin_pause_pointage: sessionEndIso,
          commentaire_pause_pointage: pauseFinalComment,
        })
        .eq('id_pause_pointage', currentPausePointageId)

      if (pauseUpdateError) {
        return false
      }

      if (currentPauseStartedAtIso) {
        registerCompletedPause(
          currentPausePointageId,
          currentPauseStartedAtIso,
          sessionEndIso,
          pauseFinalComment
        )
      }
    }

    const { error: sessionUpdateError } = await supabase
      .from('session_pointage')
      .update({
        fin_session_pointage: sessionEndIso,
        commentaire_session_pointage: sessionComment,
      })
      .eq('id_session_pointage', currentSessionPointageId)

    if (sessionUpdateError) {
      return false
    }

    const finishedEntryId = currentWorkEntryId ?? currentPointageId
    const sessionStartIso = currentSessionStartedAtIso ?? sessionEndIso
    const activePauseDurationMs =
      pointageMode === 'paused' && currentPauseStartedAtIso
        ? getDurationMsBetween(currentPauseStartedAtIso, sessionEndIso)
        : 0
    const sessionDurationMs = Math.max(
      getDurationMsBetween(sessionStartIso, sessionEndIso) -
        currentSessionPauseTotalMs -
        activePauseDurationMs,
      0
    )

    if (finishedEntryId !== null) {
      setWorkEntries((previousEntries) => {
        const nextSession: WorkSessionEntry = {
          sessionId: currentSessionPointageId,
          startIso: sessionStartIso,
          endIso: sessionEndIso,
          durationMs: sessionDurationMs,
          comment: sessionComment,
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

  const beginPointageSession = async (selectedTaskId: number, resumedEntry: WorkEntry | null) => {
    setPointageMutationPending(true)
    setPointageStopError('')

    const today = new Date()
    const sessionStartIso = getLocalTimestamp(today)
    const pointageDate = getLocalDateStamp(today)

    let nextPointageId = resumedEntry?.pointageId ?? null

    if (nextPointageId === null) {
      const { data: statusData, error: statusError } = await supabase
        .from('statut_pointage')
        .select('id_statut_pointage')
        .eq('code_statut_pointage', 'EN_COURS')
        .eq('actif', true)
        .single()

      if (statusError || !statusData) {
        setPointageStopError("Impossible de démarrer le pointage.")
        setPointageMutationPending(false)
        return
      }

      const { data: pointageData, error: pointageError } = await supabase
        .from('pointage')
        .insert({
          id_utilisateur_pointeur: connectedUserId,
          id_utilisateur_traitement: null,
          id_tache: selectedTaskId,
          id_statut_pointage: statusData.id_statut_pointage,
          date_pointage: pointageDate,
          date_traitement_pointage: null,
          remarque_admin_pointage: null,
        })
        .select('id_pointage')
        .single()

      if (pointageError || !pointageData) {
        setPointageStopError("Impossible de démarrer le pointage.")
        setPointageMutationPending(false)
        return
      }

      nextPointageId = pointageData.id_pointage
    }

    const { data: sessionData, error: sessionError } = await supabase
      .from('session_pointage')
      .insert({
        id_pointage: nextPointageId,
        debut_session_pointage: sessionStartIso,
        fin_session_pointage: null,
        commentaire_session_pointage: null,
      })
      .select('id_session_pointage')
      .single()

    if (sessionError || !sessionData) {
      if (resumedEntry === null && nextPointageId !== null) {
        await supabase.from('pointage').delete().eq('id_pointage', nextPointageId)
      }
      setPointageStopError("Impossible de démarrer le pointage.")
      setPointageMutationPending(false)
      return
    }

    const baseElapsedMs = resumedEntry?.totalDurationMs ?? 0

    const resumeComment = resumedEntry ? getLatestWorkComment(resumedEntry) : ''

    setCurrentPointageId(nextPointageId)
    setCurrentSessionPointageId(sessionData.id_session_pointage)
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
    if (pointageMutationPending || !connectedUserId || !taskChoice) {
      return
    }

    const selectedTaskId = Number(taskChoice)
    if (Number.isNaN(selectedTaskId)) {
      setPointageStopError("Impossible de démarrer sans tâche enregistrable.")
      if (stopErrorTimeoutRef.current !== null) {
        window.clearTimeout(stopErrorTimeoutRef.current)
      }
      stopErrorTimeoutRef.current = window.setTimeout(() => {
        setPointageStopError('')
        stopErrorTimeoutRef.current = null
      }, 6000)
      return
    }

    const pointageDate = getLocalDateStamp()
    const selectedTaskTitle =
      taskOptions.find((task) => task.id === String(selectedTaskId))?.title || taskLabel
    const existingPointageEntry = await getExistingPointageEntryForToday(
      selectedTaskId,
      selectedTaskTitle,
      pointageDate
    )

    await beginPointageSession(selectedTaskId, existingPointageEntry)
  }

  const pausePointage = async () => {
    if (pointageMutationPending || !currentSessionPointageId) {
      return
    }

    setPointageMutationPending(true)
    setPointageStopError('')
    setPauseComment('')
    const pauseStartIso = getLocalTimestamp()

    const { data: pauseData, error: pauseError } = await supabase
      .from('pause_pointage')
      .insert({
        id_session_pointage: currentSessionPointageId,
        debut_pause_pointage: pauseStartIso,
        fin_pause_pointage: null,
        commentaire_pause_pointage: null,
      })
      .select('id_pause_pointage, debut_pause_pointage')
      .single()

    if (pauseError || !pauseData) {
      setPointageStopError("Impossible de mettre le pointage en pause.")
      setPointageMutationPending(false)
      return
    }

    setCurrentPausePointageId(pauseData.id_pause_pointage)
    setCurrentPauseStartedAtIso(pauseData.debut_pause_pointage ?? pauseStartIso)
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
    const pauseEndIso = getLocalTimestamp()
    const pauseFinalComment = pauseComment.trim() || null

    const { error: pauseUpdateError } = await supabase
      .from('pause_pointage')
      .update({
        fin_pause_pointage: pauseEndIso,
        commentaire_pause_pointage: pauseFinalComment,
      })
      .eq('id_pause_pointage', currentPausePointageId)

    if (pauseUpdateError) {
      setPointageStopError("Impossible de reprendre le pointage.")
      setPointageMutationPending(false)
      return
    }

    if (currentPauseStartedAtIso) {
      const completedPauseDurationMs = getDurationMsBetween(currentPauseStartedAtIso, pauseEndIso)
      registerCompletedPause(
        currentPausePointageId,
        currentPauseStartedAtIso,
        pauseEndIso,
        pauseFinalComment
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
    if (taskChoice === OTHER_ACTIVITY_TASK_ID && pointageComment.trim() === '') {
      setPointageStopError('Veuillez ajouter un commentaire.')
      if (stopErrorTimeoutRef.current !== null) {
        window.clearTimeout(stopErrorTimeoutRef.current)
      }
      stopErrorTimeoutRef.current = window.setTimeout(() => {
        setPointageStopError('')
        stopErrorTimeoutRef.current = null
      }, 6000)
      return
    }

    if (pointageMutationPending || !currentSessionPointageId) {
      return
    }

    setPointageMutationPending(true)
    setPointageStopError('')
    const stopTimestamp = getLocalTimestamp()
    const didClose = await closeCurrentSession(stopTimestamp, pointageComment.trim() || null)
    if (!didClose) {
      setPointageStopError("Impossible d'arrêter le pointage.")
      setPointageMutationPending(false)
      return
    }
    setPointageMutationPending(false)
  }

  const validatePointage = () => {
    setPointageValidationPreviewDate(new Date())
  }

  const taskLabel =
    currentWorkEntry?.taskTitle ||
    taskOptions.find((task) => task.id === taskChoice)?.title ||
    'Tâche non renseignée'
  const canValidatePointage =
    pointageMode === 'idle' &&
    workEntries.length > 0 &&
    !pointageMutationPending
  const pointageReviewEntries = useMemo(
    () =>
      workEntries.map((entry) => ({
        pointageId: entry.pointageId,
        taskTitle: entry.taskTitle,
        comment: getLatestWorkComment(entry) || '-',
        totalDurationLabel: formatDuration(entry.totalDurationMs),
      })),
    [workEntries]
  )
  const isSuiviActivitesActive =
    activeMenu === 'suivi_activites' ||
    activeMenu === 'gestion_taches' ||
    activeMenu === 'gestion_demandes' ||
    activeMenu === 'gestion_pointages'
  const menuLabels: Record<ActiveMenu, string> = {
    accueil: 'Mon agenda',
    pointer: 'Mon pointage',
    taches: 'Mes tâches',
    demandes: 'Mes demandes',
    suivi_activites: 'Suivi des activités',
    gestion_demandes: 'Gestion des demandes',
    gestion_taches: 'Gestion des tâches',
    gestion_pointages: 'Gestion des pointages',
    gestion_bdd: 'Configuration',
  }

  const prepareWorkResume = async (entry: WorkEntry) => {
    if (pointageMode !== 'idle' || pointageMutationPending) {
      return
    }

    setTaskChoice(entry.taskId)
    const selectedTaskId = Number(entry.taskId)
    if (Number.isNaN(selectedTaskId)) {
      setPointageStopError("Impossible de relancer sans tâche enregistrable.")
      return
    }

    await beginPointageSession(selectedTaskId, entry)
  }

  const handleLogout = async () => {
    if (pointageMode !== 'idle' && currentSessionPointageId && !pointageMutationPending) {
      setPointageMutationPending(true)
      const didClose = await closeCurrentSession(
        getLocalTimestamp(),
        pointageComment.trim() || null
      )
      setPointageMutationPending(false)
      if (!didClose) {
        setPointageStopError("Impossible d'arrêter automatiquement le pointage.")
        return
      }
    }

    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(CONNECTED_USERNAME_STORAGE_KEY)
    }

    router.push('/')
  }

  return (
    <div className={styles.page}>
      <header className={styles.topBar}>
        <div className={styles.brandArea}>
          <h1 className={styles.brandTitle}>Jarvis Time</h1>
        </div>
        <div className={styles.profileArea}>
          <div className={styles.profileMenuWrap}>
            {connectedUsername ? (
              <span className={styles.profileName} title={connectedUsername}>
                {connectedUsername}
              </span>
            ) : null}
            <div className={styles.profileButton} aria-label="Menu utilisateur">
              <span className={styles.profileIcon} aria-hidden="true">
                <span className={styles.iconHead} />
                <span className={styles.iconBody} />
              </span>
            </div>
            <div className={styles.profileDropdown} role="menu" aria-label="Menu utilisateur">
              <button type="button" className={styles.profileDropdownItem} role="menuitem">
                {'Param\u00E8tres'}
              </button>
              <button
                type="button"
                className={styles.profileDropdownItem}
                role="menuitem"
                onClick={handleLogout}
              >
                {'Se d\u00E9connecter'}
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className={styles.middleZone} aria-label="Zone intermediaire">
        <div className={styles.tabStrip} role="tablist" aria-label="Choix onglets">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'tab1'}
            className={`${styles.tabButton} ${
              activeTab === 'tab1' ? styles.tabButtonActive : ''
            }`}
            onClick={() => setActiveTab('tab1')}
          >
            Mon espace
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'tab2'}
            className={`${styles.tabButton} ${
              activeTab === 'tab2' ? styles.tabButtonActive : ''
            }`}
            onClick={() => setActiveTab('tab2')}
          >
            Utilisateurs
          </button>
        </div>
        {activeTab === 'tab1' && activeMenu === 'accueil' ? (
          <div className={styles.agendaTabStrip} role="tablist" aria-label="Vue agenda">
            <button
              type="button"
              role="tab"
              aria-selected={activeAgendaTab === 'semaine'}
              className={`${styles.tabButton} ${
                activeAgendaTab === 'semaine' ? styles.tabButtonActive : ''
              }`}
              onClick={() => setActiveAgendaTab('semaine')}
            >
              Semaine
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeAgendaTab === 'mois'}
              className={`${styles.tabButton} ${
                activeAgendaTab === 'mois' ? styles.tabButtonActive : ''
              }`}
              onClick={() => setActiveAgendaTab('mois')}
            >
              Mois
            </button>
          </div>
        ) : activeTab === 'tab1' && activeMenu === 'pointer' ? (
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
              Données
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
        ) : null}
      </div>

      <main className={styles.layout}>
        <aside className={styles.menuZone} aria-label="Zone menu">
          {activeTab === 'tab1' ? (
            <nav className={styles.verticalMenu} aria-label="Menu principal">
              <button
                type="button"
                className={`${styles.menuItem} ${
                  activeMenu === 'accueil' ? styles.menuItemActive : ''
                }`}
                onClick={() => {
                  setActiveMenu('accueil')
                  setActiveAgendaTab('semaine')
                  resetToToday()
                }}
              >
                Mon agenda
              </button>
              <button
                type="button"
                className={`${styles.menuItem} ${
                  activeMenu === 'pointer' ? styles.menuItemActive : ''
                }`}
                onClick={() => {
                  setActiveMenu('pointer')
                  setActivePointagesSubMenu('nouveau')
                }}
              >
                Mon pointage
              </button>
              <button
                type="button"
                className={`${styles.menuItem} ${
                  activeMenu === 'taches' ? styles.menuItemActive : ''
                }`}
                onClick={() => setActiveMenu('taches')}
              >
                Mes tâches
              </button>
              <button
                type="button"
                className={`${styles.menuItem} ${
                  activeMenu === 'demandes' ? styles.menuItemActive : ''
                }`}
                onClick={() => {
                  setActiveMenu('demandes')
                  setActiveDemandesSubMenu(null)
                }}
              >
                Mes demandes
              </button>
              {activeMenu === 'demandes' ? (
                <div className={styles.subMenu} aria-label="Sous-menu Mes demandes">
                  <button
                    type="button"
                    className={`${styles.subMenuItem} ${
                      activeDemandesSubMenu === 'nouvelle' ? styles.subMenuItemActive : ''
                    }`}
                    onClick={() => setActiveDemandesSubMenu('nouvelle')}
                  >
                    Nouvelle demande
                  </button>
                  <button
                    type="button"
                    className={`${styles.subMenuItem} ${
                      activeDemandesSubMenu === 'voir' ? styles.subMenuItemActive : ''
                    }`}
                    onClick={() => setActiveDemandesSubMenu('voir')}
                  >
                    Consulter mes demandes
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                className={`${styles.menuItem} ${
                  isSuiviActivitesActive ? styles.menuItemActive : ''
                }`}
                onClick={() => setActiveMenu('gestion_taches')}
              >
                Suivi des activités
              </button>
              {isSuiviActivitesActive ? (
                <div className={styles.subMenu} aria-label="Sous-menu Suivi des activités">
                  <button
                    type="button"
                    className={`${styles.subMenuItem} ${
                      activeMenu === 'gestion_taches' ? styles.subMenuItemActive : ''
                    }`}
                    onClick={() => setActiveMenu('gestion_taches')}
                  >
                    Gestion des tâches
                  </button>
                  <button
                    type="button"
                    className={`${styles.subMenuItem} ${
                      activeMenu === 'gestion_demandes' ? styles.subMenuItemActive : ''
                    }`}
                    onClick={() => setActiveMenu('gestion_demandes')}
                  >
                    Gestion des demandes
                  </button>
                  <button
                    type="button"
                    className={`${styles.subMenuItem} ${
                      activeMenu === 'gestion_pointages' ? styles.subMenuItemActive : ''
                    }`}
                    onClick={() => setActiveMenu('gestion_pointages')}
                  >
                    Gestion des pointages
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                className={`${styles.menuItem} ${
                  activeMenu === 'gestion_bdd' ? styles.menuItemActive : ''
                }`}
                onClick={() => {
                  setActiveMenu('gestion_bdd')
                  setActiveConfigurationSubMenu('taches')
                  setActiveConfigurationTab('donnees')
                }}
              >
                Configuration
              </button>
              {activeMenu === 'gestion_bdd' ? (
                <div className={styles.subMenu} aria-label="Sous-menu Configuration">
                  <button
                    type="button"
                    className={`${styles.subMenuItem} ${
                      activeConfigurationSubMenu === 'taches' ? styles.subMenuItemActive : ''
                    }`}
                    onClick={() => setActiveConfigurationSubMenu('taches')}
                  >
                    Tâches
                  </button>
                </div>
              ) : null}
            </nav>
          ) : null}
        </aside>
        <section className={styles.actionZone} aria-label="Zone actions">
          {activeTab === 'tab1' && activeMenu === 'accueil' ? (
            <div className={styles.agendaWrap}>
              <div className={styles.agendaHeader}>
                <button
                  type="button"
                  className={styles.weekNavButton}
                  aria-label={activeAgendaTab === 'semaine' ? 'Semaine précédente' : 'Mois précédent'}
                  onClick={activeAgendaTab === 'semaine' ? goToPreviousWeek : goToPreviousMonth}
                >
                  ‹
                </button>
                <p className={styles.agendaRange}>
                  {activeAgendaTab === 'semaine' ? weekRangeLabel : monthRangeLabel}
                </p>
                <button
                  type="button"
                  className={styles.weekNavButton}
                  aria-label={activeAgendaTab === 'semaine' ? 'Semaine suivante' : 'Mois suivant'}
                  onClick={activeAgendaTab === 'semaine' ? goToNextWeek : goToNextMonth}
                >
                  ›
                </button>
                <div className={styles.dateControls}>
                  <div className={styles.datePickers}>
                    <select
                      className={styles.dateSelect}
                      aria-label="Jour"
                      value={selectedDay}
                      onChange={(event) => handleSelectedDayChange(Number(event.target.value))}
                    >
                      {Array.from({ length: daysInSelectedMonth }, (_, index) => index + 1).map(
                        (day) => (
                          <option key={`day-${day}`} value={day}>
                            {String(day).padStart(2, '0')}
                          </option>
                        )
                      )}
                    </select>
                    <select
                      className={styles.dateSelect}
                      aria-label="Mois"
                      value={selectedMonth}
                      onChange={(event) => handleSelectedMonthChange(Number(event.target.value))}
                    >
                      {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                        <option key={`month-${month}`} value={month}>
                          {String(month).padStart(2, '0')}
                        </option>
                      ))}
                    </select>
                    <select
                      className={styles.dateSelect}
                      aria-label="Année"
                      value={selectedYear}
                      onChange={(event) => handleSelectedYearChange(Number(event.target.value))}
                    >
                      {yearOptions.map((year) => (
                        <option key={`year-${year}`} value={year}>
                          {year}
                        </option>
                      ))}
                    </select>
                  </div>
                  {!isCurrentPeriod ? (
                    <button
                      type="button"
                      className={styles.todayButton}
                      aria-label={"Revenir à aujourd'hui"}
                      onClick={resetToToday}
                    >
                      ↺ Aujourd&apos;hui
                    </button>
                  ) : null}
                </div>
              </div>
              {activeAgendaTab === 'semaine' ? (
                <div className={styles.cardsScrollArea}>
                  <div className={styles.weekGrid}>
                    <div className={styles.weekHourColumn}>
                      <div className={styles.weekHourHeaderSpacer} aria-hidden="true" />
                      <div className={styles.weekHourRail}>
                        <div className={styles.weekHourList}>
                          {AGENDA_HOURS.map((hourLabel) => (
                            <div key={hourLabel} className={styles.weekHourRow}>
                              <span className={styles.weekHourLabel}>{hourLabel}</span>
                              <span className={styles.weekHourDash} aria-hidden="true">
                                -
                              </span>
                              <span className={styles.weekHourDot} aria-hidden="true" />
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    {weekDays.map((day, index) => {
                      const isToday = isSameCalendarDay(day, todayAtLoad)
                      return (
                        <div key={day.toISOString()} className={styles.dayColumn}>
                          <article
                            className={`${styles.dayCard} ${styles.dayCardHeader} ${
                              isToday ? styles.dayCardToday : ''
                            }`}
                          >
                            <p className={styles.dayName}>
                              {WEEKDAY_NAMES[index]} -{' '}
                              {day.toLocaleDateString('fr-FR', {
                                day: '2-digit',
                                month: '2-digit',
                                year: '2-digit',
                              })}
                            </p>
                          </article>
                          <article
                            className={`${styles.dayCard} ${styles.dayCardEmpty} ${
                              isToday ? styles.dayCardToday : ''
                            }`}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <div className={styles.cardsScrollArea}>
                  <div className={styles.monthCalendar}>
                    {WEEKDAY_NAMES.map((dayName) => (
                      <div key={`month-head-${dayName}`} className={styles.monthHeadCell}>
                        {dayName}
                      </div>
                    ))}
                    {monthCalendarCells.map((day, index) => {
                      if (!day) {
                        return <div key={`empty-${index}`} className={styles.monthCellEmpty} />
                      }
                      const isToday = isSameCalendarDay(day, todayAtLoad)
                      return (
                        <div
                          key={day.toISOString()}
                          className={`${styles.monthCell} ${isToday ? styles.monthCellToday : ''}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => setMonthDetailDate(day)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              setMonthDetailDate(day)
                            }
                          }}
                        >
                          <span className={styles.monthCellDayNumber}>{day.getDate()}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : activeTab === 'tab1' &&
            activeMenu === 'pointer' &&
            activePointagesSubMenu === 'nouveau' ? (
            <div className={styles.pointageLayout}>
              <div className={styles.pointageTopPane}>
                <div className={`${styles.statsCard} ${styles.statsCardWork}`}>
                  <div className={styles.statsCardTitle}>TEMPS DE TRAVAIL</div>
                  <div className={styles.statsCardValue}>
                    <span>{formatDurationParts(displayedTotalWorkMs).hours}</span>
                    <span className={styles.statsUnit}>H</span>
                    <span className={styles.statsSep}> - </span>
                    <span>{formatDurationParts(displayedTotalWorkMs).minutes}</span>
                    <span className={styles.statsUnit}>MIN</span>
                    <span className={styles.statsSep}> - </span>
                    <span>{formatDurationParts(displayedTotalWorkMs).seconds}</span>
                    <span className={styles.statsUnit}>SEC</span>
                  </div>
                </div>
                <div className={`${styles.statsCard} ${styles.statsCardPause}`}>
                  <div className={styles.statsCardTitle}>TEMPS DE PAUSE</div>
                  <div className={styles.statsCardValue}>
                    <span>{formatDurationParts(displayedTotalPauseMs).hours}</span>
                    <span className={styles.statsUnit}>H</span>
                    <span className={styles.statsSep}> - </span>
                    <span>{formatDurationParts(displayedTotalPauseMs).minutes}</span>
                    <span className={styles.statsUnit}>MIN</span>
                    <span className={styles.statsSep}> - </span>
                    <span>{formatDurationParts(displayedTotalPauseMs).seconds}</span>
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
              <div className={styles.pointageBottomPane}>
                <div className={styles.pointageBottomScroll}>
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
                          <select
                            className={styles.pointageSelect}
                            aria-label="Type de tâche"
                            value={taskChoice}
                            onChange={(event) => setTaskChoice(event.target.value)}
                            disabled={taskLoading || taskOptions.length === 0 || pointageMutationPending}
                          >
                            {taskChoice ? null : (
                              <option value="" disabled>
                                {taskLoading
                                  ? 'Chargement des tâches...'
                                  : taskLoadError || 'Aucune tâche attribuée'}
                              </option>
                            )}
                            {taskOptions.map((task) => (
                              <option key={task.id} value={task.id}>
                                {task.title}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <div className={styles.pointageTextZone}>{taskLabel}</div>
                        )}
                        <div className={styles.pointageTimer}>{formatDuration(workElapsedMs)}</div>
                        {pointageMode === 'idle' ? (
                          <button
                            type="button"
                            className={`${styles.pointageActionBtn} ${styles.pointageStartBtn}`}
                            onClick={startPointage}
                            disabled={!taskChoice || taskLoading || pointageMutationPending}
                          >
                            DÉMARRER
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
                              Arrêter
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
                              Arrêter
                            </button>
                          </>
                        )}

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
                  {workEntries.length > 0 ? (
                    <div className={styles.workHistoryOuter}>
                      <section className={styles.workHistoryBlock} aria-label="Mes travaux">
                        <div className={styles.workHistoryHeader}>
                          <h2 className={styles.workHistoryTitle}>MES TRAVAUX</h2>
                          <div className={styles.workHistoryTotal}>
                            {formatDuration(totalTrackedWorkMs)}
                          </div>
                        </div>
                        <div className={styles.workHistoryBody}>
                          {workEntries.map((entry) => {
                            const latestComment = getLatestWorkComment(entry)
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
                                  {latestComment || '-'}
                                </div>
                                <div className={styles.workHistoryActions}>
                                  <button
                                    type="button"
                                    className={styles.workHistoryIconBtn}
                                    aria-label={`Relancer ${entry.taskTitle}`}
                                    title="Relancer cette tâche"
                                    onClick={() => prepareWorkResume(entry)}
                                    disabled={
                                      isEntryLocked ||
                                      pointageMode !== 'idle' ||
                                      pointageMutationPending
                                    }
                                  >
                                    ▶
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </section>
                    </div>
                  ) : null}
                  {pauseEntries.length > 0 ? (
                    <div className={styles.pauseHistoryOuter}>
                      <section className={styles.pauseHistoryBlock} aria-label="Mes pauses">
                        <div className={styles.pauseHistoryHeader}>
                          <h2 className={styles.pauseHistoryTitle}>MES PAUSES</h2>
                          <div className={styles.pauseHistoryTotal}>
                            {formatDuration(totalTrackedPauseMs)}
                          </div>
                        </div>
                        <div className={styles.pauseHistoryBody}>
                          {pauseEntries.map((entry) => {
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
                                  {`Pause • ${entry.taskTitle}`}
                                </div>
                                <div className={styles.pauseHistoryTimes}>
                                  {entry.pauses.map((pause) => (
                                    <div key={pause.pauseId} className={styles.pauseHistoryTimeRange}>
                                      {formatTimeLabel(pause.startIso)} - {formatTimeLabel(pause.endIso)}
                                      {pause.comment ? ` (${pause.comment})` : ''}
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
                  ? 'Données'
                  : 'Historique'
                : menuLabels[activeMenu]}
            </div>
          )}
        </section>
      </main>
      {monthDetailDate ? (
        <div className={styles.monthDetailOverlay} onClick={() => setMonthDetailDate(null)}>
          <div
            className={styles.monthDetailPanel}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Détail de la journée"
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
                aria-label="Fermer le détail"
                onClick={() => setMonthDetailDate(null)}
              >
                &times;
              </button>
            </div>
            <article className={styles.monthDetailEmptyCard} />
          </div>
        </div>
      ) : null}
      {pointageValidationPreviewDate ? (
        <div
          className={styles.pointageReviewOverlay}
          onClick={() => setPointageValidationPreviewDate(null)}
        >
          <div
            className={styles.pointageReviewPanel}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Validation du pointage"
          >
            <div className={styles.pointageReviewHeaderRow}>
              <p className={styles.pointageReviewDateLabel}>
                {pointageValidationPreviewDate.toLocaleDateString('fr-FR', {
                  weekday: 'long',
                })}{' '}
                -{' '}
                {pointageValidationPreviewDate.toLocaleDateString('fr-FR', {
                  day: '2-digit',
                  month: '2-digit',
                  year: '2-digit',
                })}
              </p>
              <button
                type="button"
                className={styles.pointageReviewClose}
                aria-label="Fermer la validation du pointage"
                onClick={() => setPointageValidationPreviewDate(null)}
              >
                &times;
              </button>
            </div>
            <article className={styles.pointageReviewContentCard}>
              <div className={styles.pointageReviewSummaryCard}>
                <span className={styles.pointageReviewSummaryValue}>
                  {formatDuration(totalTrackedWorkMs)}
                </span>
              </div>
              <div className={styles.pointageReviewEntries}>
                {pointageReviewEntries.map((entry) => (
                  <article
                    key={entry.pointageId}
                    className={styles.pointageReviewTaskCard}
                    aria-label={`Synthèse de ${entry.taskTitle}`}
                  >
                    <h3 className={styles.pointageReviewTaskTitle}>{entry.taskTitle}</h3>
                    <div className={styles.pointageReviewTaskComment}>{entry.comment}</div>
                    <div className={styles.pointageReviewTaskDuration}>
                      {entry.totalDurationLabel}
                    </div>
                  </article>
                ))}
              </div>
            </article>
            <button
              type="button"
              className={styles.pointageReviewValidateBtn}
              aria-label="Valider le pointage"
            >
              Valider
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
