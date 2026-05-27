'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import { AppShell } from '../../components/app-shell'
import type { ShellNavigationOptions } from '../../lib/app-ui-state'
import {
  CONNECTED_USERNAME_CHANGED_EVENT,
  CONNECTED_USERNAME_STORAGE_KEY,
  DEFAULT_UI_STATE,
  readStoredUiState,
  readStoredUsername,
  subscribeToUiStateStorage,
  subscribeToUsernameStorage,
  updatePersistedUiState,
} from '../../lib/app-ui-state'
import { supabase } from '../../lib/supabase'
import styles from './page.module.css'

const LOCAL_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/

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

type PointageBoundsOverlayState = {
  dateLabel: string
  startTimeLabel: string
  endTimeLabel: string
}

type TaskSessionsOverlayState = {
  taskTitle: string
  sessions: Array<{ startLabel: string; endLabel: string }>
}
type TodayLiveSession = {
  startIso: string
  endIso: string | null
  comment: string | null
  stopReasonCode: string | null
  stopReasonLabel: string | null
}
type TodayLiveTask = {
  taskKey: string
  taskId: string
  taskTitle: string
  sessions: TodayLiveSession[]
}

type SelectedUserProfile = {
  prenom: string
  nom: string
  username: string
  email: string
  telephone: string
  adresse: string
  pointageStartHour: string
  pointageStartMinute: string
  pointageEndHour: string
  pointageEndMinute: string
  statusCode: 'EN_ATTENTE' | 'ACTIVE' | 'DESACTIVE' | null
  createdAtLabel: string
}
type PointageRangeStorage = {
  startKey: string | null
  endKey: string | null
}

type AssignedTaskListItem = {
  id: number
  title: string
  description: string
  priorityId: number | null
  dueAtMs: number | null
}

type TasksSortKey = 'title' | 'priority' | 'deadline'
type TasksSortDirection = 'asc' | 'desc'

function padTimeUnit(value: number) {
  return String(value).padStart(2, '0')
}

function getLocalDateStamp(referenceDate: Date = new Date()) {
  return `${referenceDate.getFullYear()}-${padTimeUnit(referenceDate.getMonth() + 1)}-${padTimeUnit(referenceDate.getDate())}`
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate()
}

function getWeekdayCountInMonth(year: number, monthIndexZeroBased: number) {
  const dayCount = new Date(year, monthIndexZeroBased + 1, 0).getDate()
  let weekdays = 0
  for (let day = 1; day <= dayCount; day += 1) {
    const weekDay = new Date(year, monthIndexZeroBased, day).getDay()
    if (weekDay >= 1 && weekDay <= 5) weekdays += 1
  }
  return weekdays
}

function addMonths(referenceDate: Date, monthCount: number) {
  const nextDate = new Date(referenceDate)
  nextDate.setMonth(referenceDate.getMonth() + monthCount)
  return nextDate
}

function isSameCalendarDay(dateA: Date, dateB: Date) {
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  )
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.floor(durationMs / 1000)
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

function formatDurationParts(durationMs: number) {
  const safeDuration = Math.max(0, durationMs)
  const totalSeconds = Math.floor(safeDuration / 1000)
  return {
    hours: String(Math.floor(totalSeconds / 3600)).padStart(2, '0'),
    minutes: String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0'),
    seconds: String(totalSeconds % 60).padStart(2, '0'),
  }
}

function formatTimeLabel(isoString: string) {
  return parseStoredTimestamp(isoString).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getDurationMsBetween(startTimestamp: string, endTimestamp: string) {
  return Math.max(
    parseStoredTimestamp(endTimestamp).getTime() - parseStoredTimestamp(startTimestamp).getTime(),
    0
  )
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
    normalizedComment.startsWith('pause arretee automatiquement apres') ||
    normalizedComment.startsWith('session arrêtée pour inactivité') ||
    normalizedComment.startsWith('session arretee pour inactivite') ||
    normalizedComment.startsWith("arrêt à cause de") ||
    normalizedComment.startsWith('arret a cause de')
  )
}

function sanitizeUserComment(comment: string | null | undefined) {
  if (!comment) return null
  return isSystemAutoStopComment(comment) ? null : comment
}

function buildTaskGroupingKey(taskId: number | string, taskTitle: string) {
  return `${String(taskId)}::${taskTitle.trim().toLocaleLowerCase('fr-FR')}`
}

function capitalizeFirstLetter(value: string) {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function normalizeStatusCode(value: unknown): 'EN_ATTENTE' | 'ACTIVE' | 'DESACTIVE' | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  if (normalized === 'EN_ATTENTE' || normalized === 'ACTIVE' || normalized === 'DESACTIVE') {
    return normalized
  }
  return null
}

function pickCreatedAtLabel(row: Record<string, unknown>) {
  const candidates = [
    row.date_creation_utilisateur,
    row.created_at,
    row.createdat,
    row.date_creation,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      const date = parseStoredTimestamp(value)
      if (!Number.isNaN(date.getTime())) {
        return date.toLocaleDateString('fr-FR')
      }
    }
  }
  return '--/--/----'
}

function minutesToHourRange(value: unknown) {
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes < 0) return ''
  const hoursPart = Math.floor(minutes / 60)
  const minutesPart = minutes % 60
  return `${String(hoursPart).padStart(2, '0')}:${String(minutesPart).padStart(2, '0')}`
}

function splitHourRange(value: string) {
  const normalized = value.trim()
  const match = normalized.match(/^(\d{2}):(\d{2})$/)
  if (!match) {
    return { hour: '08', minute: '00' }
  }
  return { hour: match[1], minute: match[2] }
}

function rangeToExpectedMinutes(startHour: string, startMinute: string, endHour: string, endMinute: string) {
  const start = Number(startHour) * 60 + Number(startMinute)
  const end = Number(endHour) * 60 + Number(endMinute)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null
  }
  return end - start
}

function pickFirstTimeValue(row: Record<string, unknown>, candidates: string[]) {
  for (const key of candidates) {
    const value = row[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    const match = trimmed.match(/^(\d{2}):(\d{2})/)
    if (match) {
      return { key, hour: match[1], minute: match[2] }
    }
  }
  return null
}

function HoverScrollText({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLSpanElement | null>(null)
  const [overflowDistance, setOverflowDistance] = useState(0)

  useEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) return

    const computeOverflow = () => {
      const distance = Math.max(0, content.scrollWidth - container.clientWidth)
      setOverflowDistance(distance)
    }

    computeOverflow()

    const resizeObserver = new ResizeObserver(() => {
      computeOverflow()
    })

    resizeObserver.observe(container)
    resizeObserver.observe(content)
    return () => resizeObserver.disconnect()
  }, [text])

  const style = {
    '--hover-scroll-distance': `${overflowDistance}px`,
  } as CSSProperties

  return (
    <div
      ref={containerRef}
      className={`${styles.hoverScrollCell} ${className ?? ''} ${
        overflowDistance > 0 ? styles.hoverScrollCellActive : ''
      }`}
      style={style}
      title={text}
    >
      <span ref={contentRef} className={styles.hoverScrollText}>
        {text}
      </span>
    </div>
  )
}

function HoverScrollContent({
  contentKey,
  title,
  className,
  children,
}: {
  contentKey: string
  title: string
  className?: string
  children: ReactNode
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLSpanElement | null>(null)
  const [overflowDistance, setOverflowDistance] = useState(0)

  useEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) return

    const computeOverflow = () => {
      const distance = Math.max(0, content.scrollWidth - container.clientWidth)
      setOverflowDistance(distance)
    }

    computeOverflow()
    const resizeObserver = new ResizeObserver(computeOverflow)
    resizeObserver.observe(container)
    resizeObserver.observe(content)
    return () => resizeObserver.disconnect()
  }, [contentKey])

  const style = {
    '--hover-scroll-distance': `${overflowDistance}px`,
  } as CSSProperties

  return (
    <div
      ref={containerRef}
      className={`${styles.hoverScrollCell} ${className ?? ''} ${
        overflowDistance > 0 ? styles.hoverScrollCellActive : ''
      }`}
      style={style}
      title={title}
    >
      <span ref={contentRef} className={styles.hoverScrollText}>
        {children}
      </span>
    </div>
  )
}

function getPriorityCursorPercent(priorityId: number | null) {
  switch (priorityId) {
    case 1:
      return 12.5
    case 2:
      return 37.5
    case 3:
      return 62.5
    case 4:
      return 87.5
    default:
      return 50
  }
}

function splitRemainingDuration(remainingMs: number) {
  const safeRemaining = Math.max(0, Math.floor(Math.abs(remainingMs)))
  const totalSeconds = Math.floor(safeRemaining / 1000)
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  }
}

function parseTaskDueDateToMs(value: unknown) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  const normalizedValue = value.trim()
  const dateOnlyMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      23,
      59,
      59,
      999
    ).getTime()
  }

  const parsed = new Date(normalizedValue)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.getTime()
}

const WEEKDAY_NAMES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche']

export default function UtilisateursPage() {
  const router = useRouter()
  const uiState = useSyncExternalStore(
    subscribeToUiStateStorage,
    readStoredUiState,
    () => DEFAULT_UI_STATE
  )
  const connectedUsername = useSyncExternalStore(
    subscribeToUsernameStorage,
    readStoredUsername,
    () => ''
  )
  const [connectedUserId, setConnectedUserId] = useState<number | null>(null)
  const [connectedUserRole, setConnectedUserRole] = useState<'ADMIN' | 'EMPLOYE'>('EMPLOYE')
  const [usersTabList, setUsersTabList] = useState<
    Array<{
      id: number
      firstName: string
      lastName: string
      statusCode: string
      hasActiveSession: boolean
    }>
  >([])
  const [usersTabLoading, setUsersTabLoading] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [selectedUserTab, setSelectedUserTab] = useState<'profil' | 'pointages' | 'taches'>('profil')
  const [selectedUserProfile, setSelectedUserProfile] = useState<SelectedUserProfile | null>(null)
  const [profileStatusPending, setProfileStatusPending] = useState(false)
  const [profileRangePending, setProfileRangePending] = useState(false)
  const [pointageRangeStorage, setPointageRangeStorage] = useState<PointageRangeStorage>({
    startKey: null,
    endKey: null,
  })
  const [usersPointagesView, setUsersPointagesView] = useState<'aujourdhui' | 'agenda'>('agenda')
  const [selectedUserExpectedDailyDurationMs, setSelectedUserExpectedDailyDurationMs] = useState<number | null>(
    null
  )
  const [agendaDaySummaries, setAgendaDaySummaries] = useState<Record<string, DaySummary>>({})
  const [todayLiveTasks, setTodayLiveTasks] = useState<TodayLiveTask[]>([])
  const [monthDetailDate, setMonthDetailDate] = useState<Date | null>(null)
  const [pointageBoundsOverlay, setPointageBoundsOverlay] = useState<PointageBoundsOverlayState | null>(null)
  const [taskSessionsOverlay, setTaskSessionsOverlay] = useState<TaskSessionsOverlayState | null>(null)
  const [assignedTasks, setAssignedTasks] = useState<AssignedTaskListItem[]>([])
  const [assignedTasksLoading, setAssignedTasksLoading] = useState(false)
  const [assignedTasksError, setAssignedTasksError] = useState('')
  const [tasksSearchTerm, setTasksSearchTerm] = useState('')
  const [tasksSortKey, setTasksSortKey] = useState<TasksSortKey>('title')
  const [tasksSortDirection, setTasksSortDirection] = useState<TasksSortDirection>('asc')
  const [tasksNowMs, setTasksNowMs] = useState(() => Date.now())
  const [taskCollaboratorsByTaskId, setTaskCollaboratorsByTaskId] = useState<Map<number, string[]>>(new Map())

  const { activeMenu, activeDemandesSubMenu, activeConfigurationSubMenu, activeConfigurationTab } =
    uiState

  const todayAtLoad = useMemo(() => new Date(), [])
  const [selectedDay, setSelectedDay] = useState(todayAtLoad.getDate())
  const [selectedMonth, setSelectedMonth] = useState(todayAtLoad.getMonth() + 1)
  const [selectedYear, setSelectedYear] = useState(todayAtLoad.getFullYear())

  const displayedDate = useMemo(
    () => new Date(selectedYear, selectedMonth - 1, Math.min(selectedDay, getDaysInMonth(selectedYear, selectedMonth))),
    [selectedDay, selectedMonth, selectedYear]
  )
  const monthStart = useMemo(
    () => new Date(displayedDate.getFullYear(), displayedDate.getMonth(), 1),
    [displayedDate]
  )
  const monthEnd = useMemo(
    () => new Date(displayedDate.getFullYear(), displayedDate.getMonth() + 1, 0),
    [displayedDate]
  )

  const monthRangeLabel = useMemo(
    () =>
      `${monthStart.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })} - ${monthEnd.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })}`,
    [monthEnd, monthStart]
  )

  const monthCalendarCells = useMemo(() => {
    const startWeekDay = monthStart.getDay()
    const leadingEmptyCells = startWeekDay === 0 ? 6 : startWeekDay - 1
    const daysCount = monthEnd.getDate()
    const days = Array.from({ length: daysCount }, (_, index) => {
      const dayDate = new Date(monthStart)
      dayDate.setDate(index + 1)
      return dayDate
    })
    const trailingEmptyCells = (7 - ((leadingEmptyCells + days.length) % 7)) % 7

    return [
      ...Array.from({ length: leadingEmptyCells }, () => null),
      ...days,
      ...Array.from({ length: trailingEmptyCells }, () => null),
    ]
  }, [monthStart, monthEnd])

  const maxSelectableYear = todayAtLoad.getFullYear() + 1
  const yearOptions = useMemo(() => {
    const firstYear = 2026
    const years: number[] = []
    for (let year = firstYear; year <= maxSelectableYear; year += 1) years.push(year)
    return years
  }, [maxSelectableYear])

  useEffect(() => {
    let cancelled = false

    const syncSession = async () => {
      const response = await fetch('/api/auth/session', { cache: 'no-store' })
      if (!response.ok) {
        if (!cancelled) router.replace('/')
        return
      }

      const payload = (await response.json()) as {
        userId?: number
        role?: string
        user?: { id?: number }
      }
      const userId = Number(payload.userId ?? payload.user?.id ?? NaN)
      if (!cancelled) {
        setConnectedUserId(Number.isFinite(userId) ? userId : null)
        setConnectedUserRole(payload.role === 'ADMIN' ? 'ADMIN' : 'EMPLOYE')
      }
    }

    void syncSession()
    return () => {
      cancelled = true
    }
  }, [router])

  useEffect(() => {
    if (connectedUserId === null) return

    let cancelled = false
    const loadUsers = async () => {
      setUsersTabLoading(true)
      const { data, error } = await supabase
        .from('utilisateur')
        .select(
          'id_utilisateur, prenom_utilisateur, nom_utilisateur, id_statut_utilisateur!inner(code_statut_utilisateur)'
        )
        .neq('id_utilisateur', connectedUserId)
        .order('prenom_utilisateur', { ascending: true })
        .order('nom_utilisateur', { ascending: true })

      if (cancelled) return
      if (error || !data) {
        setUsersTabList([])
        setSelectedUserId(null)
        setUsersTabLoading(false)
        return
      }

      const normalizedUsers = data.map((user) => ({
        id: user.id_utilisateur,
        firstName: (user.prenom_utilisateur ?? '').trim(),
        lastName: (user.nom_utilisateur ?? '').trim(),
        statusCode:
          (user.id_statut_utilisateur as unknown as { code_statut_utilisateur?: string } | null)
            ?.code_statut_utilisateur ?? '',
        hasActiveSession: false,
      }))

      const activeCandidateUserIds = normalizedUsers
        .filter((user) => user.statusCode === 'ACTIVE')
        .map((user) => user.id)

      if (activeCandidateUserIds.length > 0) {
        const { data: activeSessionRows } = await supabase
          .from('session_pointage')
          .select('id_session_pointage, id_pointage, pointage!inner(id_utilisateur_pointeur)')
          .is('fin_session_pointage', null)
          .in('pointage.id_utilisateur_pointeur', activeCandidateUserIds)

        const onlineUserIds = new Set<number>(
          (activeSessionRows ?? [])
            .map((row) => {
              const pointageRow = row.pointage as unknown as
                | { id_utilisateur_pointeur?: number }
                | Array<{ id_utilisateur_pointeur?: number }>
                | null
              if (Array.isArray(pointageRow)) {
                return Number(pointageRow[0]?.id_utilisateur_pointeur)
              }
              return Number(pointageRow?.id_utilisateur_pointeur)
            })
            .filter((value) => Number.isFinite(value))
        )

        for (const user of normalizedUsers) {
          if (user.statusCode === 'ACTIVE') {
            user.hasActiveSession = onlineUserIds.has(user.id)
          }
        }
      }
      setUsersTabList(normalizedUsers)
      setSelectedUserId((previous) => {
        if (previous !== null && normalizedUsers.some((user) => user.id === previous)) return previous
        return normalizedUsers.length > 0 ? normalizedUsers[0].id : null
      })
      setUsersTabLoading(false)
    }

    void loadUsers()
    return () => {
      cancelled = true
    }
  }, [connectedUserId])

  useEffect(() => {
    if (selectedUserId === null) {
      setSelectedUserExpectedDailyDurationMs(null)
      return
    }
    let cancelled = false
    const loadExpectedDuration = async () => {
      const { data, error } = await supabase
        .from('utilisateur')
        .select('duree_journaliere_attendue_utilisateur')
        .eq('id_utilisateur', selectedUserId)
        .single()
      if (cancelled) return
      if (error || !data) {
        setSelectedUserExpectedDailyDurationMs(null)
        return
      }
      const expectedDailyMinutes = Number(data.duree_journaliere_attendue_utilisateur)
      if (!Number.isFinite(expectedDailyMinutes) || expectedDailyMinutes < 0) {
        setSelectedUserExpectedDailyDurationMs(null)
        return
      }
      setSelectedUserExpectedDailyDurationMs(expectedDailyMinutes * 60 * 1000)
    }
    void loadExpectedDuration()
    return () => {
      cancelled = true
    }
  }, [selectedUserId])

  useEffect(() => {
    if (selectedUserId === null) {
      setSelectedUserProfile(null)
      return
    }

    let cancelled = false
    const loadSelectedUserProfile = async () => {
      const { data, error } = await supabase
        .from('utilisateur')
        .select('*, id_statut_utilisateur!inner(code_statut_utilisateur)')
        .eq('id_utilisateur', selectedUserId)
        .single()

      if (cancelled) return
      if (error || !data) {
        setSelectedUserProfile(null)
        return
      }

      const relationStatusCode = normalizeStatusCode(
        (data.id_statut_utilisateur as { code_statut_utilisateur?: string } | null)
          ?.code_statut_utilisateur
      )
      const directStatusCode = normalizeStatusCode(
        (data as Record<string, unknown>).code_statut_utilisateur
      )

      const rawRow = data as Record<string, unknown>
      const startCandidate = pickFirstTimeValue(rawRow, [
        'heure_min_pointage',
        'heure_debut_pointage_autorisee',
        'heure_debut_plage_pointage',
        'heure_debut_autorisation_pointage',
        'debut_plage_horaire_pointage_utilisateur',
      ])
      const endCandidate = pickFirstTimeValue(rawRow, [
        'heure_max_pointage',
        'heure_fin_pointage_autorisee',
        'heure_fin_plage_pointage',
        'heure_fin_autorisation_pointage',
        'fin_plage_horaire_pointage_utilisateur',
      ])
      const durationLabel = minutesToHourRange(data.duree_journaliere_attendue_utilisateur)
      const fallbackStart = splitHourRange('08:00')
      const fallbackEnd = splitHourRange(durationLabel || '16:00')

      setPointageRangeStorage({
        startKey: startCandidate?.key ?? 'heure_min_pointage',
        endKey: endCandidate?.key ?? 'heure_max_pointage',
      })

      setSelectedUserProfile({
        pointageStartHour: startCandidate?.hour ?? fallbackStart.hour,
        pointageStartMinute: startCandidate?.minute ?? fallbackStart.minute,
        pointageEndHour: endCandidate?.hour ?? fallbackEnd.hour,
        pointageEndMinute: endCandidate?.minute ?? fallbackEnd.minute,
        prenom: (data.prenom_utilisateur ?? '').trim(),
        nom: (data.nom_utilisateur ?? '').trim(),
        username: (data.username_utilisateur ?? '').trim(),
        email: (data.email_utilisateur ?? '').trim(),
        telephone: (data.telephone_utilisateur ?? '').trim(),
        adresse: (data.adresse_utilisateur ?? '').trim(),
        statusCode: relationStatusCode ?? directStatusCode,
        createdAtLabel: pickCreatedAtLabel(data as Record<string, unknown>),
      })
    }

    void loadSelectedUserProfile()
    return () => {
      cancelled = true
    }
  }, [selectedUserId])

  const updateSelectedUserStatus = async () => {
    if (!selectedUserId || !selectedUserProfile?.statusCode || profileStatusPending) return

    const targetStatusCode =
      selectedUserProfile.statusCode === 'EN_ATTENTE'
        ? 'ACTIVE'
        : selectedUserProfile.statusCode === 'ACTIVE'
          ? 'DESACTIVE'
          : 'ACTIVE'

    setProfileStatusPending(true)
    const { data: statusRow, error: statusError } = await supabase
      .from('statut_utilisateur')
      .select('id_statut_utilisateur')
      .eq('code_statut_utilisateur', targetStatusCode)
      .eq('actif', true)
      .single()

    if (statusError || !statusRow) {
      setProfileStatusPending(false)
      return
    }

    const { error: updateError } = await supabase
      .from('utilisateur')
      .update({ id_statut_utilisateur: statusRow.id_statut_utilisateur })
      .eq('id_utilisateur', selectedUserId)

    if (!updateError) {
      setSelectedUserProfile((previous) =>
        previous
          ? {
              ...previous,
              statusCode: targetStatusCode,
            }
          : previous
      )
      setUsersTabList((previousList) =>
        previousList.map((user) =>
          user.id === selectedUserId
            ? {
                ...user,
                statusCode: targetStatusCode,
                hasActiveSession: targetStatusCode === 'ACTIVE' ? user.hasActiveSession : false,
              }
            : user
        )
      )
    }

    setProfileStatusPending(false)
  }

  const saveSelectedUserPointageRange = async () => {
    if (!selectedUserId || !selectedUserProfile || profileRangePending) return
    const parsedMinutes = rangeToExpectedMinutes(
      selectedUserProfile.pointageStartHour,
      selectedUserProfile.pointageStartMinute,
      selectedUserProfile.pointageEndHour,
      selectedUserProfile.pointageEndMinute
    )
    if (parsedMinutes === null) return

    setProfileRangePending(true)
    const startValue = `${selectedUserProfile.pointageStartHour}:${selectedUserProfile.pointageStartMinute}:00`
    const endValue = `${selectedUserProfile.pointageEndHour}:${selectedUserProfile.pointageEndMinute}:00`
    const updatePayload: Record<string, unknown> = {
      duree_journaliere_attendue_utilisateur: parsedMinutes,
    }
    if (pointageRangeStorage.startKey) {
      updatePayload[pointageRangeStorage.startKey] = startValue
    }
    if (pointageRangeStorage.endKey) {
      updatePayload[pointageRangeStorage.endKey] = endValue
    }

    const { error } = await supabase
      .from('utilisateur')
      .update(updatePayload)
      .eq('id_utilisateur', selectedUserId)
    if (!error) {
      setSelectedUserExpectedDailyDurationMs(parsedMinutes * 60 * 1000)
      setSelectedUserProfile((previous) =>
        previous
          ? {
              ...previous,
            }
          : previous
      )
    }
    setProfileRangePending(false)
  }

  useEffect(() => {
    if (selectedUserId === null) {
      setAssignedTasks([])
      setAssignedTasksError('')
      setAssignedTasksLoading(false)
      setTaskCollaboratorsByTaskId(new Map())
      return
    }

    let cancelled = false

    const loadAssignedTasks = async () => {
      setAssignedTasksLoading(true)
      setAssignedTasksError('')

      const { data: assignedTasksData, error: assignedTasksErrorResponse } = await supabase
        .from('utilisateur_tache')
        .select('id_tache, date_echeance_tache')
        .eq('id_utilisateur', selectedUserId)

      if (cancelled) return
      if (assignedTasksErrorResponse || !assignedTasksData) {
        setAssignedTasks([])
        setAssignedTasksError('Impossible de charger les tâches.')
        setAssignedTasksLoading(false)
        return
      }

      if (assignedTasksData.length === 0) {
        setAssignedTasks([])
        setTaskCollaboratorsByTaskId(new Map())
        setAssignedTasksLoading(false)
        return
      }

      const taskIds = assignedTasksData.map((taskLink) => taskLink.id_tache)
      const { data: tasksData, error: tasksError } = await supabase
        .from('tache')
        .select(
          'id_tache, titre_tache, description_tache, id_priorite_tache, actif, tache_systeme'
        )
        .in('id_tache', taskIds)
        .eq('actif', true)

      if (cancelled) return
      if (tasksError || !tasksData) {
        setAssignedTasks([])
        setAssignedTasksError('Impossible de charger les tâches.')
        setTaskCollaboratorsByTaskId(new Map())
        setAssignedTasksLoading(false)
        return
      }

      const systemTaskData = tasksData.find((task) => task.tache_systeme === true)
      const systemTaskId = systemTaskData?.id_tache ?? null
      const dueDateByTaskId = new Map<number, number | null>(
        assignedTasksData.map((taskLink) => {
          const rawDueAt = taskLink.date_echeance_tache
          const dueAtMs = parseTaskDueDateToMs(rawDueAt)
          return [taskLink.id_tache, dueAtMs]
        })
      )

      const nextTasks = tasksData
        .filter((task) => task.id_tache !== systemTaskId)
        .map((task) => ({
          id: task.id_tache,
          title: task.titre_tache || 'Tâche sans titre',
          description: task.description_tache || '-',
          priorityId: task.id_priorite_tache ?? null,
          dueAtMs: dueDateByTaskId.get(task.id_tache) ?? null,
        }))

      const filteredTaskIds = nextTasks.map((task) => task.id)
      let collaboratorsByTaskId = new Map<number, string[]>()
      if (filteredTaskIds.length > 0) {
        const { data: collaboratorLinks } = await supabase
          .from('utilisateur_tache')
          .select('id_tache, id_utilisateur')
          .in('id_tache', filteredTaskIds)

        const collaboratorUserIds = Array.from(
          new Set(
            (collaboratorLinks ?? [])
              .map((link) => Number(link.id_utilisateur))
              .filter((value) => Number.isFinite(value))
          )
        )

        const collaboratorNameById = new Map<number, string>()
        if (collaboratorUserIds.length > 0) {
          const { data: collaboratorUsers } = await supabase
            .from('utilisateur')
            .select('id_utilisateur, prenom_utilisateur, nom_utilisateur')
            .in('id_utilisateur', collaboratorUserIds)
          for (const collaborator of collaboratorUsers ?? []) {
            collaboratorNameById.set(
              collaborator.id_utilisateur,
              `${(collaborator.prenom_utilisateur ?? '').trim()} ${(collaborator.nom_utilisateur ?? '').trim()}`.trim()
            )
          }
        }

        collaboratorsByTaskId = (collaboratorLinks ?? []).reduce((map, link) => {
          const taskId = Number(link.id_tache)
          const userId = Number(link.id_utilisateur)
          const userLabel = collaboratorNameById.get(userId)
          if (!Number.isFinite(taskId) || !userLabel) return map
          const existing = map.get(taskId) ?? []
          if (!existing.includes(userLabel)) existing.push(userLabel)
          map.set(taskId, existing)
          return map
        }, new Map<number, string[]>())
      }

      for (const task of nextTasks) {
        const existing = collaboratorsByTaskId.get(task.id) ?? []
        const sorted = [...existing].sort((a, b) =>
          a.localeCompare(b, 'fr', { sensitivity: 'base' })
        )
        collaboratorsByTaskId.set(task.id, sorted)
      }

      setAssignedTasks(nextTasks)
      setTaskCollaboratorsByTaskId(collaboratorsByTaskId)
      setAssignedTasksLoading(false)
    }

    void loadAssignedTasks()
    return () => {
      cancelled = true
    }
  }, [selectedUserId])

  useEffect(() => {
    const tick = window.setInterval(() => {
      setTasksNowMs(Date.now())
    }, 1000)
    return () => window.clearInterval(tick)
  }, [])

  useEffect(() => {
    if (selectedUserId === null) {
      setTodayLiveTasks([])
      return
    }

    let cancelled = false
    const loadTodayLiveTasks = async () => {
      const todayStamp = getLocalDateStamp(new Date())
      const { data: pointageRows, error: pointageError } = await supabase
        .from('pointage')
        .select('id_pointage, id_tache, libelle_tache_libre_pointage')
        .eq('id_utilisateur_pointeur', selectedUserId)
        .eq('date_pointage', todayStamp)
        .order('id_pointage', { ascending: true })

      if (cancelled || pointageError || !pointageRows || pointageRows.length === 0) {
        if (!cancelled) setTodayLiveTasks([])
        return
      }

      const taskIds = Array.from(new Set(pointageRows.map((row) => Number(row.id_tache)).filter(Number.isFinite)))
      const { data: taskRows } =
        taskIds.length > 0
          ? await supabase.from('tache').select('id_tache, titre_tache').in('id_tache', taskIds)
          : { data: [] as Array<{ id_tache: number; titre_tache: string | null }> }
      const taskTitleById = new Map<number, string>((taskRows ?? []).map((task) => [task.id_tache, task.titre_tache ?? '']))
      const pointageMetaById = new Map<number, { taskId: number; taskTitle: string }>(
        pointageRows.map((row) => [
          row.id_pointage,
          {
            taskId: row.id_tache,
            taskTitle: (row.libelle_tache_libre_pointage ?? '').trim() || taskTitleById.get(row.id_tache) || 'Tâche non renseignée',
          },
        ])
      )

      const pointageIds = pointageRows.map((row) => row.id_pointage)
      const { data: sessionRows, error: sessionError } = await supabase
        .from('session_pointage')
        .select(
          'id_pointage, debut_session_pointage, fin_session_pointage, commentaire_session_pointage, motif_arret_session:motif_arret_session!fk_session_pointage_motif_arret_session(code_motif_arret_session, libelle_motif_arret_session)'
        )
        .in('id_pointage', pointageIds)
        .order('debut_session_pointage', { ascending: true })

      if (cancelled || sessionError || !sessionRows) {
        if (!cancelled) setTodayLiveTasks([])
        return
      }

      const grouped = new Map<string, TodayLiveTask>()
      for (const session of sessionRows) {
        const meta = pointageMetaById.get(session.id_pointage)
        if (!meta) continue
        const taskKey = buildTaskGroupingKey(meta.taskId, meta.taskTitle)
        const existing = grouped.get(taskKey)
        if (!existing) {
          grouped.set(taskKey, {
            taskKey,
            taskId: String(meta.taskId),
            taskTitle: meta.taskTitle,
            sessions: [
              {
                startIso: session.debut_session_pointage,
                endIso: session.fin_session_pointage ?? null,
                comment: sanitizeUserComment(session.commentaire_session_pointage),
                stopReasonCode: session.motif_arret_session?.code_motif_arret_session ?? null,
                stopReasonLabel: session.motif_arret_session?.libelle_motif_arret_session ?? null,
              },
            ],
          })
        } else {
          existing.sessions.push({
            startIso: session.debut_session_pointage,
            endIso: session.fin_session_pointage ?? null,
            comment: sanitizeUserComment(session.commentaire_session_pointage),
            stopReasonCode: session.motif_arret_session?.code_motif_arret_session ?? null,
            stopReasonLabel: session.motif_arret_session?.libelle_motif_arret_session ?? null,
          })
        }
      }

      if (!cancelled) {
        setTodayLiveTasks(Array.from(grouped.values()).sort((a, b) => a.taskTitle.localeCompare(b.taskTitle)))
      }
    }

    void loadTodayLiveTasks()
    const refresh = window.setInterval(() => {
      void loadTodayLiveTasks()
    }, 30000)
    return () => {
      cancelled = true
      window.clearInterval(refresh)
    }
  }, [selectedUserId, usersPointagesView])

  useEffect(() => {
    if (selectedUserId === null) {
      setAgendaDaySummaries({})
      return
    }

    let cancelled = false

    const loadSummaries = async () => {
      const { data: termineStatusData, error: termineStatusError } = await supabase
        .from('statut_pointage')
        .select('id_statut_pointage')
        .eq('code_statut_pointage', 'TERMINE')
        .single()
      if (cancelled || termineStatusError || !termineStatusData) return

      const rangeStart = getLocalDateStamp(monthStart)
      const rangeEnd = getLocalDateStamp(monthEnd)

      const { data: pointageRows, error: pointageError } = await supabase
        .from('pointage')
        .select('id_pointage, id_tache, date_pointage, libelle_tache_libre_pointage')
        .eq('id_utilisateur_pointeur', selectedUserId)
        .eq('id_statut_pointage', termineStatusData.id_statut_pointage)
        .gte('date_pointage', rangeStart)
        .lte('date_pointage', rangeEnd)
        .order('date_pointage', { ascending: true })

      if (cancelled || pointageError || !pointageRows || pointageRows.length === 0) {
        if (!cancelled) setAgendaDaySummaries({})
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

      if (cancelled || sessionError || !sessionRows) return

      const taskTitleById = new Map<number, string>((taskRows ?? []).map((task) => [task.id_tache, task.titre_tache]))
      const pointageById = new Map<number, { taskId: number; dateStamp: string; taskTitle: string }>(
        pointageRows.map((row) => [
          row.id_pointage,
          {
            taskId: row.id_tache,
            dateStamp: row.date_pointage,
            taskTitle: (row.libelle_tache_libre_pointage ?? '').trim() || taskTitleById.get(row.id_tache) || 'Tâche non renseignée',
          },
        ])
      )

      const summariesByDay = new Map<string, Map<string, DayTaskSummary>>()
      for (const session of sessionRows) {
        if (!session.fin_session_pointage) continue
        const sourcePointage = pointageById.get(session.id_pointage)
        if (!sourcePointage) continue
        if (!summariesByDay.has(sourcePointage.dateStamp)) summariesByDay.set(sourcePointage.dateStamp, new Map())

        const taskMap = summariesByDay.get(sourcePointage.dateStamp) as Map<string, DayTaskSummary>
        const taskKey = buildTaskGroupingKey(sourcePointage.taskId, sourcePointage.taskTitle)
        const durationMs = getDurationMsBetween(session.debut_session_pointage, session.fin_session_pointage)
        const latestComment = sanitizeUserComment(session.commentaire_session_pointage) || '-'
        const existingSummary = taskMap.get(taskKey)
        const existingComment = existingSummary?.comment ?? '-'
        const shouldAppendComment =
          latestComment !== '-' &&
          latestComment !== existingComment &&
          !existingComment.split('-').map((part) => part.trim()).includes(latestComment)

        taskMap.set(taskKey, {
          taskKey,
          taskId: String(sourcePointage.taskId),
          taskTitle: sourcePointage.taskTitle,
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
        const tasks = Array.from(taskMap.values()).sort((a, b) => a.taskTitle.localeCompare(b.taskTitle))
        nextSummaries[dateStamp] = {
          dateStamp,
          tasks,
          totalWorkMs: tasks.reduce((sum, task) => sum + task.totalDurationMs, 0),
        }
      }

      if (!cancelled) setAgendaDaySummaries(nextSummaries)
    }

    void loadSummaries()
    return () => {
      cancelled = true
    }
  }, [monthEnd, monthStart, selectedUserId])

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

  const resetToToday = () => {
    setSelectedDay(todayAtLoad.getDate())
    setSelectedMonth(todayAtLoad.getMonth() + 1)
    setSelectedYear(todayAtLoad.getFullYear())
  }

  const daysInSelectedMonth = useMemo(() => getDaysInMonth(selectedYear, selectedMonth), [selectedYear, selectedMonth])
  const handleSelectedMonthChange = (month: number) => {
    setSelectedMonth(month)
    setSelectedDay((previousDay) => Math.min(previousDay, getDaysInMonth(selectedYear, month)))
  }
  const handleSelectedYearChange = (year: number) => {
    setSelectedYear(year)
    setSelectedDay((previousDay) => Math.min(previousDay, getDaysInMonth(year, selectedMonth)))
  }
  const monthDetailSummary = monthDetailDate ? agendaDaySummaries[getLocalDateStamp(monthDetailDate)] ?? null : null
  const monthDetailHasDailyTargetStatus =
    monthDetailDate !== null &&
    monthDetailSummary !== null &&
    selectedUserExpectedDailyDurationMs !== null &&
    getLocalDateStamp(monthDetailDate) < getLocalDateStamp(todayAtLoad)
  const monthDetailDailyTargetReached =
    monthDetailHasDailyTargetStatus &&
    monthDetailSummary !== null &&
    selectedUserExpectedDailyDurationMs !== null &&
    monthDetailSummary.totalWorkMs >= selectedUserExpectedDailyDurationMs
  const monthWorkedDurationMs = useMemo(
    () => Object.values(agendaDaySummaries).reduce((sum, daySummary) => sum + daySummary.totalWorkMs, 0),
    [agendaDaySummaries]
  )
  const monthExpectedDurationMs = useMemo(() => {
    if (selectedUserExpectedDailyDurationMs === null) return null
    const weekdayCount = getWeekdayCountInMonth(selectedYear, selectedMonth - 1)
    return weekdayCount * selectedUserExpectedDailyDurationMs
  }, [selectedMonth, selectedUserExpectedDailyDurationMs, selectedYear])
  const monthWorkedDurationParts = useMemo(
    () => formatDurationParts(monthWorkedDurationMs),
    [monthWorkedDurationMs]
  )
  const monthExpectedDurationParts = useMemo(
    () => (monthExpectedDurationMs === null ? null : formatDurationParts(monthExpectedDurationMs)),
    [monthExpectedDurationMs]
  )
  const isMonthTargetReached = monthExpectedDurationMs !== null && monthWorkedDurationMs >= monthExpectedDurationMs
  const selectedUserHasActivePointage = useMemo(() => {
    if (selectedUserId === null) return false
    const selectedUser = usersTabList.find((user) => user.id === selectedUserId)
    return selectedUser?.hasActiveSession === true
  }, [selectedUserId, usersTabList])
  const todayViewDateLabel = useMemo(() => new Date().toLocaleDateString('fr-FR'), [tasksNowMs])
  const todayLiveSummary = useMemo(() => {
    const tasks = todayLiveTasks.map((task) => {
      const totalDurationMs = task.sessions.reduce((sum, session) => {
        const endIso = session.endIso ?? new Date(tasksNowMs).toISOString()
        return sum + getDurationMsBetween(session.startIso, endIso)
      }, 0)
      return {
        ...task,
        totalDurationMs,
      }
    })
    return {
      totalWorkMs: tasks.reduce((sum, task) => sum + task.totalDurationMs, 0),
      tasks,
    }
  }, [tasksNowMs, todayLiveTasks])
  const isTodayLiveTargetReached =
    selectedUserExpectedDailyDurationMs !== null &&
    todayLiveSummary.totalWorkMs >= selectedUserExpectedDailyDurationMs

  const filteredAssignedTasks = useMemo(() => {
    const normalizedTerm = tasksSearchTerm.trim().toLocaleLowerCase('fr-FR')
    if (!normalizedTerm) return assignedTasks
    return assignedTasks.filter((task) => task.title.toLocaleLowerCase('fr-FR').includes(normalizedTerm))
  }, [assignedTasks, tasksSearchTerm])

  const sortedAssignedTasks = useMemo(() => {
    const directionMultiplier = tasksSortDirection === 'asc' ? 1 : -1
    return [...filteredAssignedTasks].sort((leftTask, rightTask) => {
      if (tasksSortKey === 'title') {
        return (
          leftTask.title.localeCompare(rightTask.title, 'fr', { sensitivity: 'base' }) * directionMultiplier
        )
      }

      if (tasksSortKey === 'priority') {
        const leftPriority = leftTask.priorityId ?? Number.POSITIVE_INFINITY
        const rightPriority = rightTask.priorityId ?? Number.POSITIVE_INFINITY
        if (leftPriority === rightPriority) return 0
        return (leftPriority < rightPriority ? -1 : 1) * directionMultiplier
      }

      const leftDeadline = leftTask.dueAtMs ?? Number.POSITIVE_INFINITY
      const rightDeadline = rightTask.dueAtMs ?? Number.POSITIVE_INFINITY
      if (leftDeadline === rightDeadline) return 0
      return (leftDeadline < rightDeadline ? -1 : 1) * directionMultiplier
    })
  }, [filteredAssignedTasks, tasksSortDirection, tasksSortKey])

  const toggleTasksSort = useCallback(
    (key: TasksSortKey) => {
      if (tasksSortKey === key) {
        setTasksSortDirection((previousDirection) =>
          previousDirection === 'asc' ? 'desc' : 'asc'
        )
        return
      }

      setTasksSortKey(key)
      setTasksSortDirection('asc')
    },
    [tasksSortKey]
  )

  const taskDeadlineById = useMemo(() => {
    const deadlineMap = new Map<
      number,
      { hasDueAt: boolean; days: number; hours: number; minutes: number; seconds: number }
    >()
    for (const task of assignedTasks) {
      if (task.dueAtMs === null) {
        deadlineMap.set(task.id, { hasDueAt: false, ...splitRemainingDuration(0) })
        continue
      }
      const delta = task.dueAtMs - tasksNowMs
      deadlineMap.set(task.id, { hasDueAt: true, ...splitRemainingDuration(delta) })
    }
    return deadlineMap
  }, [assignedTasks, tasksNowMs])

  const openPointageBoundsOverlay = useCallback(
    async (targetDate: Date) => {
      if (selectedUserId === null) return

      const dateStamp = getLocalDateStamp(targetDate)
      const { data: pointageRows, error: pointageError } = await supabase
        .from('pointage')
        .select('id_pointage')
        .eq('id_utilisateur_pointeur', selectedUserId)
        .eq('date_pointage', dateStamp)

      if (pointageError || !pointageRows || pointageRows.length === 0) return

      const pointageIds = pointageRows.map((row) => row.id_pointage)
      const { data: sessionRows, error: sessionError } = await supabase
        .from('session_pointage')
        .select('debut_session_pointage, fin_session_pointage')
        .in('id_pointage', pointageIds)
        .not('fin_session_pointage', 'is', null)
        .order('debut_session_pointage', { ascending: true })

      if (sessionError || !sessionRows || sessionRows.length === 0) return

      const firstSession = sessionRows[0]
      const lastSession = sessionRows[sessionRows.length - 1]
      if (!lastSession.fin_session_pointage) return

      setPointageBoundsOverlay({
        dateLabel: targetDate.toLocaleDateString('fr-FR', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        }),
        startTimeLabel: formatTimeLabel(firstSession.debut_session_pointage),
        endTimeLabel: formatTimeLabel(lastSession.fin_session_pointage),
      })
    },
    [selectedUserId]
  )

  const openTaskSessionsOverlay = useCallback(
    async (targetDate: Date, task: DayTaskSummary) => {
      if (selectedUserId === null) return

      const taskId = Number(task.taskId)
      if (!Number.isFinite(taskId)) return

      const dateStamp = getLocalDateStamp(targetDate)
      const { data: pointageRows, error: pointageError } = await supabase
        .from('pointage')
        .select('id_pointage, libelle_tache_libre_pointage')
        .eq('id_utilisateur_pointeur', selectedUserId)
        .eq('date_pointage', dateStamp)
        .eq('id_tache', taskId)
        .order('id_pointage', { ascending: true })

      if (pointageError || !pointageRows || pointageRows.length === 0) return

      const { data: taskRow } = await supabase
        .from('tache')
        .select('titre_tache')
        .eq('id_tache', taskId)
        .single()

      const pointageIds = pointageRows.map((row) => row.id_pointage)
      const { data: sessionRows, error: sessionError } = await supabase
        .from('session_pointage')
        .select('id_pointage, debut_session_pointage, fin_session_pointage')
        .in('id_pointage', pointageIds)
        .not('fin_session_pointage', 'is', null)
        .order('debut_session_pointage', { ascending: true })

      if (sessionError || !sessionRows || sessionRows.length === 0) return

      const pointageFreeLabel = new Map<number, string | null>(
        pointageRows.map((row) => [row.id_pointage, row.libelle_tache_libre_pointage])
      )
      const baseTaskTitle = taskRow?.titre_tache ?? ''
      const matchedSessions = sessionRows.filter((session) => {
        const freeLabel = (pointageFreeLabel.get(session.id_pointage) ?? '').trim()
        const resolvedTitle = freeLabel || baseTaskTitle || 'Tâche non renseignée'
        return resolvedTitle === task.taskTitle
      })

      if (matchedSessions.length === 0) return

      setTaskSessionsOverlay({
        taskTitle: task.taskTitle,
        sessions: matchedSessions.map((session) => ({
          startLabel: formatTimeLabel(session.debut_session_pointage),
          endLabel: formatTimeLabel(session.fin_session_pointage as string),
        })),
      })
    },
    [selectedUserId]
  )

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
    (menu: typeof activeMenu, options?: ShellNavigationOptions) => {
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
      else if (menu === 'gestion_taches') router.push('/gestion-des-activites')
    },
    [activeMenu, router]
  )

  const handleLogout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(CONNECTED_USERNAME_STORAGE_KEY)
      window.dispatchEvent(new Event(CONNECTED_USERNAME_CHANGED_EVENT))
    }
    router.push('/')
  }, [router])

  return (
    <>
      <AppShell
        connectedUsername={connectedUsername}
        userRole={connectedUserRole}
        activeTab="tab2"
        activeMenu={activeMenu}
        activeDemandesSubMenu={activeDemandesSubMenu}
        activeConfigurationSubMenu={activeConfigurationSubMenu}
        activeConfigurationTab={activeConfigurationTab}
        onTabChange={(tab) => {
          if (tab === 'tab1') openAgendaPage()
        }}
        onOpenAgenda={openAgendaPage}
        onOpenPointage={openPointagePage}
        onOpenMenu={openShellPage}
        onConfigurationSubMenuChange={(value) =>
          updatePersistedUiState((previousState) => ({ ...previousState, activeConfigurationSubMenu: value }))
        }
        onConfigurationTabChange={(value) =>
          updatePersistedUiState((previousState) => ({ ...previousState, activeConfigurationTab: value }))
        }
        onLogout={handleLogout}
        usersList={usersTabList}
        usersListLoading={usersTabLoading}
        selectedUserId={selectedUserId}
        onSelectUser={(userId) => {
          setSelectedUserId(userId)
        }}
        middleContent={
          selectedUserId !== null ? (
            <div className={styles.usersTabStrip} role="tablist" aria-label="Vue utilisateur">
              <button
                type="button"
                role="tab"
                aria-selected={selectedUserTab === 'profil'}
                className={`${styles.usersTabButton} ${
                  selectedUserTab === 'profil' ? styles.usersTabButtonActive : ''
                }`}
                onClick={() => setSelectedUserTab('profil')}
              >
                Profil
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={selectedUserTab === 'pointages'}
                className={`${styles.usersTabButton} ${
                  selectedUserTab === 'pointages' ? styles.usersTabButtonActive : ''
                }`}
                onClick={() => {
                  setSelectedUserTab('pointages')
                  setUsersPointagesView('aujourdhui')
                }}
              >
                Pointages
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={selectedUserTab === 'taches'}
                className={`${styles.usersTabButton} ${
                  selectedUserTab === 'taches' ? styles.usersTabButtonActive : ''
                }`}
                onClick={() => setSelectedUserTab('taches')}
              >
                Tâches
              </button>
            </div>
          ) : null
        }
      >
        {selectedUserId === null ? (
          <div className={styles.zoneLabel}>Pointages</div>
        ) : selectedUserTab === 'profil' ? (
          <div className={styles.profileWrap}>
            <div className={styles.profileHeaderRow}>
              {selectedUserProfile?.statusCode ? (
                <button
                  type="button"
                  className={`${styles.profileStatusActionBtn} ${
                    selectedUserProfile.statusCode === 'ACTIVE'
                      ? styles.profileStatusActionBtnDanger
                      : styles.profileStatusActionBtnSuccess
                  }`}
                  onClick={() => {
                    void updateSelectedUserStatus()
                  }}
                  disabled={profileStatusPending}
                >
                  {selectedUserProfile.statusCode === 'EN_ATTENTE'
                    ? 'Approuver le compte'
                    : selectedUserProfile.statusCode === 'ACTIVE'
                      ? 'Désactiver'
                      : 'Activer'}
                </button>
              ) : (
                <div />
              )}
              <p className={styles.profileCreatedAtText}>
                {`Compte créé le ${selectedUserProfile?.createdAtLabel ?? '--/--/----'}`}
              </p>
            </div>
            <div className={styles.profileGrid}>
              <div className={styles.profileField}>
                <label className={styles.profileLabel}>Prénom</label>
                <input
                  type="text"
                  value={selectedUserProfile?.prenom ?? ''}
                  readOnly
                  className={styles.profileInput}
                />
              </div>
              <div className={styles.profileField}>
                <label className={styles.profileLabel}>Nom</label>
                <input
                  type="text"
                  value={selectedUserProfile?.nom ?? ''}
                  readOnly
                  className={styles.profileInput}
                />
              </div>
              <div className={styles.profileField}>
                <label className={styles.profileLabel}>Nom d'utilisateur</label>
                <input
                  type="text"
                  value={selectedUserProfile?.username ?? ''}
                  readOnly
                  className={styles.profileInput}
                />
              </div>
              <div className={styles.profileField}>
                <label className={styles.profileLabel}>Email</label>
                <input
                  type="text"
                  value={selectedUserProfile?.email ?? ''}
                  readOnly
                  className={styles.profileInput}
                />
              </div>
              <div className={styles.profileField}>
                <label className={styles.profileLabel}>Téléphone</label>
                <input
                  type="text"
                  value={selectedUserProfile?.telephone ?? ''}
                  readOnly
                  className={styles.profileInput}
                />
              </div>
              <div className={styles.profileField}>
                <label className={styles.profileLabel}>Adresse</label>
                <input
                  type="text"
                  value={selectedUserProfile?.adresse ?? ''}
                  readOnly
                  className={styles.profileInput}
                />
              </div>
              <div className={styles.profileField}>
                <label className={styles.profileLabel}>Fourchette horaire de pointage</label>
                <div
                  className={styles.pointageRangeRow}
                  onBlur={() => {
                    void saveSelectedUserPointageRange()
                  }}
                >
                  <select
                    className={styles.pointageRangeSelect}
                    value={selectedUserProfile?.pointageStartHour ?? '08'}
                    onChange={(event) =>
                      setSelectedUserProfile((previous) =>
                        previous
                          ? {
                              ...previous,
                              pointageStartHour: event.target.value,
                            }
                          : previous
                      )
                    }
                    disabled={profileRangePending}
                  >
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={`start-hour-${hour}`} value={String(hour).padStart(2, '0')}>
                        {String(hour).padStart(2, '0')}
                      </option>
                    ))}
                  </select>
                  <span className={styles.pointageRangeSep}>:</span>
                  <select
                    className={styles.pointageRangeSelect}
                    value={selectedUserProfile?.pointageStartMinute ?? '00'}
                    onChange={(event) =>
                      setSelectedUserProfile((previous) =>
                        previous
                          ? {
                              ...previous,
                              pointageStartMinute: event.target.value,
                            }
                          : previous
                      )
                    }
                    disabled={profileRangePending}
                  >
                    {['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'].map(
                      (minute) => (
                        <option key={`start-minute-${minute}`} value={minute}>
                          {minute}
                        </option>
                      )
                    )}
                  </select>
                  <span className={styles.pointageRangeDash}>-</span>
                  <select
                    className={styles.pointageRangeSelect}
                    value={selectedUserProfile?.pointageEndHour ?? '16'}
                    onChange={(event) =>
                      setSelectedUserProfile((previous) =>
                        previous
                          ? {
                              ...previous,
                              pointageEndHour: event.target.value,
                            }
                          : previous
                      )
                    }
                    disabled={profileRangePending}
                  >
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={`end-hour-${hour}`} value={String(hour).padStart(2, '0')}>
                        {String(hour).padStart(2, '0')}
                      </option>
                    ))}
                  </select>
                  <span className={styles.pointageRangeSep}>:</span>
                  <select
                    className={styles.pointageRangeSelect}
                    value={selectedUserProfile?.pointageEndMinute ?? '00'}
                    onChange={(event) =>
                      setSelectedUserProfile((previous) =>
                        previous
                          ? {
                              ...previous,
                              pointageEndMinute: event.target.value,
                            }
                          : previous
                      )
                    }
                    disabled={profileRangePending}
                  >
                    {['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'].map(
                      (minute) => (
                        <option key={`end-minute-${minute}`} value={minute}>
                          {minute}
                        </option>
                      )
                    )}
                  </select>
                </div>
              </div>
            </div>
          </div>
        ) : selectedUserTab === 'taches' ? (
          <div className={styles.tasksWrap}>
            <div className={styles.tasksToolbar}>
              <input
                type="search"
                className={styles.tasksSearchInput}
                placeholder="Rechercher une tâche..."
                value={tasksSearchTerm}
                onChange={(event) => setTasksSearchTerm(event.target.value)}
              />
            </div>
            <div className={styles.tasksBody}>
              {assignedTasksLoading ? (
                <div className={styles.tasksEmptyState}>
                  <p className={styles.tasksStateText}>Chargement des tâches...</p>
                </div>
              ) : assignedTasksError ? (
                <div className={styles.tasksEmptyState}>
                  <p className={styles.tasksStateText}>{assignedTasksError}</p>
                </div>
              ) : sortedAssignedTasks.length === 0 ? (
                <div className={styles.tasksEmptyState}>
                  <p className={styles.tasksStateText}>Aucune tâche affectée</p>
                </div>
              ) : (
                <table className={styles.tasksTable}>
                  <thead>
                    <tr>
                      <th scope="col">
                        <button
                          type="button"
                          className={styles.tasksSortButton}
                          onClick={() => toggleTasksSort('title')}
                        >
                          TÂCHE
                          {tasksSortKey === 'title' ? (tasksSortDirection === 'asc' ? ' ▲' : ' ▼') : ''}
                        </button>
                      </th>
                      <th scope="col">DESCRIPTION</th>
                      <th scope="col">
                        <button
                          type="button"
                          className={styles.tasksSortButton}
                          onClick={() => toggleTasksSort('priority')}
                        >
                          PRIORITÉ
                          {tasksSortKey === 'priority' ? (tasksSortDirection === 'asc' ? ' ▲' : ' ▼') : ''}
                        </button>
                      </th>
                      <th scope="col">
                        <button
                          type="button"
                          className={styles.tasksSortButton}
                          onClick={() => toggleTasksSort('deadline')}
                        >
                          DÉLAI
                          {tasksSortKey === 'deadline' ? (tasksSortDirection === 'asc' ? ' ▲' : ' ▼') : ''}
                        </button>
                      </th>
                      <th scope="col">ÉQUIPE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedAssignedTasks.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <HoverScrollText text={task.title} className={styles.taskTitleCell} />
                        </td>
                        <td>
                          <HoverScrollText text={task.description} className={styles.taskDescriptionCell} />
                        </td>
                        <td>
                          <div className={styles.priorityGauge} aria-label={`Priorité ${task.priorityId ?? '-'}`}>
                            <span
                              className={styles.priorityGaugeCursor}
                              style={{ left: `${getPriorityCursorPercent(task.priorityId)}%` }}
                            />
                          </div>
                        </td>
                        <td
                          className={`${styles.taskDurationCell} ${
                            task.dueAtMs !== null && task.dueAtMs < tasksNowMs
                              ? styles.taskDurationLate
                              : styles.taskDurationOnTime
                          }`}
                        >
                          {(() => {
                            const duration = taskDeadlineById.get(task.id)
                            if (!duration?.hasDueAt) return '-'
                            const rawLabel = `${duration.days}J ${String(duration.hours).padStart(2, '0')}H ${String(
                              duration.minutes
                            ).padStart(2, '0')}MIN ${String(duration.seconds).padStart(2, '0')}SEC`
                            return (
                              <HoverScrollContent
                                contentKey={rawLabel}
                                title={rawLabel}
                                className={styles.taskDurationScroll}
                              >
                                <span className={styles.taskDurationValue}>{duration.days}</span>
                                <sup className={styles.taskDurationUnit}>J</sup>{' '}
                                <span className={styles.taskDurationValue}>
                                  {String(duration.hours).padStart(2, '0')}
                                </span>
                                <sup className={styles.taskDurationUnit}>H</sup>{' '}
                                <span className={styles.taskDurationValue}>
                                  {String(duration.minutes).padStart(2, '0')}
                                </span>
                                <sup className={styles.taskDurationUnit}>MIN</sup>{' '}
                                <span className={styles.taskDurationValue}>
                                  {String(duration.seconds).padStart(2, '0')}
                                </span>
                                <sup className={styles.taskDurationUnit}>SEC</sup>
                              </HoverScrollContent>
                            )
                          })()}
                        </td>
                        <td>
                          <div className={styles.taskUsersDetails}>
                            <span className={styles.taskUsersTrigger} title="Voir les membres assignés">
                              👤
                            </span>
                            <div className={styles.taskUsersMenu}>
                              {(taskCollaboratorsByTaskId.get(task.id) ?? []).length === 0 ? (
                                <p className={styles.taskUsersEmpty}>Aucun membre</p>
                              ) : (
                                <ul className={styles.taskUsersList}>
                                  {(taskCollaboratorsByTaskId.get(task.id) ?? []).map((userName) => (
                                    <li key={`${task.id}-${userName}`} className={styles.taskUsersItem}>
                                      {userName}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.pointagesWrap}>
            <div className={styles.pointagesTopRow}>
              <div className={styles.pointagesViewsSwitch} role="tablist" aria-label="Vues pointages">
                <button
                  type="button"
                  role="tab"
                  aria-selected={usersPointagesView === 'aujourdhui'}
                  className={`${styles.pointagesViewButton} ${
                    usersPointagesView === 'aujourdhui' ? styles.pointagesViewButtonActive : ''
                  }`}
                  onClick={() => setUsersPointagesView('aujourdhui')}
                >
                  {`Aujourd'hui - ${todayViewDateLabel}`}
                </button>
                <span className={styles.pointagesViewsDivider} aria-hidden="true" />
                <button
                  type="button"
                  role="tab"
                  aria-selected={usersPointagesView === 'agenda'}
                  className={`${styles.pointagesViewButton} ${
                    usersPointagesView === 'agenda' ? styles.pointagesViewButtonActive : ''
                  }`}
                  onClick={() => setUsersPointagesView('agenda')}
                >
                  Agenda
                </button>
              </div>
            </div>
            {usersPointagesView === 'aujourdhui' ? (
              <article className={styles.monthDetailEmptyCard}>
                {(() => {
                  if (todayLiveSummary.tasks.length === 0) {
                    return (
                      <div className={styles.tasksEmptyState}>
                        <p className={styles.tasksStateText}>Aucune donnée de pointage aujourd&apos;hui</p>
                      </div>
                    )
                  }

                  return (
                    <div className={styles.monthDetailSummaryWrap}>
                      <div className={styles.todayPointageHeader}>
                        <div className={styles.todayPointageStatus}>
                          <span
                            className={`${styles.todayPointageStatusDot} ${
                              selectedUserHasActivePointage
                                ? styles.todayPointageStatusDotRunning
                                : styles.todayPointageStatusDotFinished
                            }`}
                            aria-hidden="true"
                          />
                          <span className={styles.todayPointageStatusText}>
                            {selectedUserHasActivePointage ? 'Pointage en cours' : 'Pointage terminé'}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`${styles.monthDetailSummaryTotal} ${
                          selectedUserExpectedDailyDurationMs === null
                            ? ''
                            : isTodayLiveTargetReached
                              ? styles.monthDetailSummaryTotalReached
                              : styles.monthDetailSummaryTotalMissed
                        }`}
                        onClick={() => {
                          void openPointageBoundsOverlay(new Date())
                        }}
                      >
                        {formatDuration(todayLiveSummary.totalWorkMs)}
                      </button>
                      <div className={styles.daySummaryTasks}>
                        {todayLiveSummary.tasks.map((task) => (
                          <div
                            key={task.taskKey}
                            className={styles.daySummaryTaskRow}
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              void openTaskSessionsOverlay(new Date(), {
                                taskKey: task.taskKey,
                                taskId: task.taskId,
                                taskTitle: task.taskTitle,
                                comment: '-',
                                totalDurationMs: task.totalDurationMs,
                              })
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                void openTaskSessionsOverlay(new Date(), {
                                  taskKey: task.taskKey,
                                  taskId: task.taskId,
                                  taskTitle: task.taskTitle,
                                  comment: '-',
                                  totalDurationMs: task.totalDurationMs,
                                })
                              }
                            }}
                          >
                            <div className={styles.daySummaryTaskMain}>
                              <span className={styles.daySummaryTaskTitle}>{task.taskTitle}</span>
                              <span className={styles.daySummaryTaskDuration}>
                                {formatDuration(task.totalDurationMs)}
                              </span>
                            </div>
                            <div className={styles.daySummaryTaskComment}>
                              {task.sessions.map((session, index) => {
                                const isOngoing = !session.endIso
                                const trimmedComment = session.comment?.trim() ?? ''
                                const shouldShowStopReason =
                                  session.stopReasonCode === 'ARRET_AUTO' ||
                                  session.stopReasonCode === 'INACTIVITE'
                                const stopReasonUpper =
                                  shouldShowStopReason && session.stopReasonLabel
                                    ? session.stopReasonLabel.toUpperCase()
                                    : ''
                                return (
                                  <div key={`${task.taskKey}-today-session-${index}`} className={styles.commentLine}>
                                    <span className={styles.commentMarker}>&gt;</span>{' '}
                                    {`Session ${index + 1} : ${formatTimeLabel(session.startIso)} - ${
                                      isOngoing ? '' : formatTimeLabel(session.endIso as string)
                                    }`}
                                    {trimmedComment ? ` | ${trimmedComment}` : ''}
                                    {stopReasonUpper ? (
                                      <>
                                        {' | '}
                                        <span className={styles.todaySessionStopReason}>{`(${stopReasonUpper})`}</span>
                                      </>
                                    ) : null}
                                    {isOngoing ? (
                                      <span className={styles.todaySessionRunning}>{' (EN COURS)'}</span>
                                    ) : null}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}
              </article>
            ) : (
          <div className={styles.agendaWrap}>
            <div className={styles.agendaHeader}>
              <button
                type="button"
                className={styles.weekNavButton}
                aria-label="Mois précédent"
                onClick={goToPreviousMonth}
              >
                &#8249;
              </button>
              <p className={styles.agendaRange}>{monthRangeLabel}</p>
              <button
                type="button"
                className={styles.weekNavButton}
                aria-label="Mois suivant"
                onClick={goToNextMonth}
              >
                &#8250;
              </button>

              <select
                className={styles.dateSelect}
                value={selectedDay}
                onChange={(event) => setSelectedDay(Number(event.target.value))}
                aria-label="Jour"
              >
                {Array.from({ length: daysInSelectedMonth }, (_, index) => index + 1).map((day) => (
                  <option key={`day-${day}`} value={day}>
                    {String(day).padStart(2, '0')}
                  </option>
                ))}
              </select>
              <select
                className={styles.dateSelect}
                value={selectedMonth}
                onChange={(event) => handleSelectedMonthChange(Number(event.target.value))}
                aria-label="Mois"
              >
                {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                  <option key={`month-${month}`} value={month}>
                    {String(month).padStart(2, '0')}
                  </option>
                ))}
              </select>
              <select
                className={styles.dateSelect}
                value={selectedYear}
                onChange={(event) => handleSelectedYearChange(Number(event.target.value))}
                aria-label="Année"
              >
                {yearOptions.map((year) => (
                  <option key={`year-${year}`} value={year}>
                    {year}
                  </option>
                ))}
              </select>

              {!isSameCalendarDay(displayedDate, todayAtLoad) ? (
                <button
                  type="button"
                  className={styles.todayButton}
                  onClick={resetToToday}
                  aria-label="Revenir à aujourd'hui"
                >
                  Aujourd&apos;hui
                </button>
              ) : null}
              {monthExpectedDurationParts ? (
                <div className={styles.expectedDurationBadge} aria-label="Durée faite sur durée attendue">
                  <span
                    className={`${styles.expectedDurationWorked} ${
                      isMonthTargetReached
                        ? styles.expectedDurationWorkedReached
                        : styles.expectedDurationWorkedMissed
                    }`}
                  >
                    <span>{monthWorkedDurationParts.hours}</span>
                    <span className={styles.expectedDurationUnit}>H</span>
                    <span className={styles.expectedDurationSep}> - </span>
                    <span>{monthWorkedDurationParts.minutes}</span>
                    <span className={styles.expectedDurationUnit}>MIN</span>
                    <span className={styles.expectedDurationSep}> - </span>
                    <span>{monthWorkedDurationParts.seconds}</span>
                    <span className={styles.expectedDurationUnit}>SEC</span>
                  </span>
                  <span className={styles.expectedDurationSlash}> / </span>
                  <span>{monthExpectedDurationParts.hours}</span>
                  <span className={styles.expectedDurationUnit}>H</span>
                  <span className={styles.expectedDurationSep}> - </span>
                  <span>{monthExpectedDurationParts.minutes}</span>
                  <span className={styles.expectedDurationUnit}>MIN</span>
                  <span className={styles.expectedDurationSep}> - </span>
                  <span>{monthExpectedDurationParts.seconds}</span>
                  <span className={styles.expectedDurationUnit}>SEC</span>
                </div>
              ) : null}
            </div>

            <div className={styles.cardsScrollArea}>
              <div className={styles.monthCalendar}>
                {WEEKDAY_NAMES.map((dayName) => (
                  <div key={`month-head-${dayName}`} className={styles.monthHeadCell}>
                    {dayName}
                  </div>
                ))}
                {monthCalendarCells.map((day, index) => {
                  if (!day) return <div key={`empty-${index}`} className={styles.monthCellEmpty} />

                  const dayStamp = getLocalDateStamp(day)
                  const todayStamp = getLocalDateStamp(todayAtLoad)
                  const isToday = isSameCalendarDay(day, todayAtLoad)
                  const daySummary = agendaDaySummaries[dayStamp] ?? null
                  const canColorizeCompletedDay = dayStamp < todayStamp
                  const hasDailyTargetStatus =
                    selectedUserExpectedDailyDurationMs !== null && daySummary && canColorizeCompletedDay
                  const isDailyTargetReached =
                    hasDailyTargetStatus &&
                    daySummary !== null &&
                    selectedUserExpectedDailyDurationMs !== null &&
                    daySummary.totalWorkMs >= selectedUserExpectedDailyDurationMs

                  return (
                    <div
                      key={day.toISOString()}
                      className={`${styles.monthCell} ${isToday ? styles.monthCellToday : ''} ${
                        hasDailyTargetStatus
                          ? isDailyTargetReached
                            ? styles.monthCellStatusSuccess
                            : styles.monthCellStatusDanger
                          : ''
                      }`}
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
                      {daySummary ? (
                        <span
                          className={`${styles.monthCellWorkTotal} ${
                            hasDailyTargetStatus
                              ? isDailyTargetReached
                                ? styles.monthCellWorkTotalReached
                                : styles.monthCellWorkTotalMissed
                              : ''
                          }`}
                        >
                          {formatDuration(daySummary.totalWorkMs)}
                        </span>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
            )}
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
            aria-label="Détail de la journée"
          >
            <div className={styles.monthDetailHeaderRow}>
              <article className={styles.monthDetailMainCard}>
                <p className={styles.dayName}>
                  {capitalizeFirstLetter(
                    monthDetailDate.toLocaleDateString('fr-FR', {
                      weekday: 'long',
                    })
                  )}{' '}
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
            <article className={styles.monthDetailEmptyCard}>
              {monthDetailSummary ? (
                <div className={styles.monthDetailSummaryWrap}>
                  <button
                    type="button"
                    className={`${styles.monthDetailSummaryTotal} ${
                      monthDetailHasDailyTargetStatus
                        ? monthDetailDailyTargetReached
                          ? styles.monthDetailSummaryTotalReached
                          : styles.monthDetailSummaryTotalMissed
                        : ''
                    }`}
                    onClick={() => {
                      void openPointageBoundsOverlay(monthDetailDate)
                    }}
                  >
                    {formatDuration(monthDetailSummary.totalWorkMs)}
                  </button>
                  <div className={styles.daySummaryTasks}>
                    {monthDetailSummary.tasks.map((task) => (
                      <div
                        key={task.taskKey}
                        className={styles.daySummaryTaskRow}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          void openTaskSessionsOverlay(monthDetailDate, task)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            void openTaskSessionsOverlay(monthDetailDate, task)
                          }
                        }}
                      >
                        <div className={styles.daySummaryTaskMain}>
                          <span className={styles.daySummaryTaskTitle}>{task.taskTitle}</span>
                          <span className={styles.daySummaryTaskDuration}>
                            {formatDuration(task.totalDurationMs)}
                          </span>
                        </div>
                        {task.comment !== '-' ? (
                          <div className={styles.daySummaryTaskComment}>
                            {splitCommentLines(task.comment).map((line, index) => (
                              <div key={`${task.taskKey}-comment-${index}`} className={styles.commentLine}>
                                <span className={styles.commentMarker}>&gt;</span> {line}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </article>
          </div>
        </div>
      ) : null}
      {pointageBoundsOverlay ? (
        <div className={styles.monthDetailOverlay} onClick={() => setPointageBoundsOverlay(null)}>
          <div
            className={styles.pointageBoundsPanel}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Heures de pointage de la journée"
          >
            <button
              type="button"
              className={styles.pointageBoundsClose}
              aria-label="Fermer le détail des heures de pointage"
              onClick={() => setPointageBoundsOverlay(null)}
            >
              &times;
            </button>
            <p className={styles.pointageBoundsDate}>{pointageBoundsOverlay.dateLabel}</p>
            <p className={styles.pointageBoundsLine}>
              <strong>Début pointage :</strong> {pointageBoundsOverlay.startTimeLabel}
            </p>
            <p className={styles.pointageBoundsLine}>
              <strong>Fin pointage :</strong> {pointageBoundsOverlay.endTimeLabel}
            </p>
          </div>
        </div>
      ) : null}
      {taskSessionsOverlay ? (
        <div className={styles.monthDetailOverlay} onClick={() => setTaskSessionsOverlay(null)}>
          <div
            className={styles.pointageBoundsPanel}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Sessions de la tâche"
          >
            <button
              type="button"
              className={styles.pointageBoundsClose}
              aria-label="Fermer le détail des sessions"
              onClick={() => setTaskSessionsOverlay(null)}
            >
              &times;
            </button>
            <p className={styles.pointageBoundsDate}>{taskSessionsOverlay.taskTitle}</p>
            {taskSessionsOverlay.sessions.map((session, index) => (
              <p key={`${session.startLabel}-${session.endLabel}-${index}`} className={styles.pointageBoundsLine}>
                <strong>{`Session ${index + 1}`}</strong> : {session.startLabel} - {session.endLabel}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}

