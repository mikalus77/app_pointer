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
import type { ActiveMenu, ShellNavigationOptions } from '../../lib/app-ui-state'
import {
  CONNECTED_USERNAME_CHANGED_EVENT,
  CONNECTED_USERNAME_STORAGE_KEY,
  readStoredUsername,
  subscribeToUsernameStorage,
  updatePersistedUiState,
} from '../../lib/app-ui-state'
import { supabase } from '../../lib/supabase'
import styles from './page.module.css'

type AssignedTaskListItem = {
  id: number
  title: string
  description: string
  priorityId: number | null
  dueAtMs: number | null
}

type TasksSortKey = 'title' | 'priority' | 'deadline'
type TasksSortDirection = 'asc' | 'desc'

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

function parseTaskDueDateToMs(value: unknown) {
  if (typeof value !== 'string' || value.trim().length === 0) return null

  const normalizedValue = value.trim()
  const dateOnlyMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnlyMatch) {
    const [, yearText, monthText, dayText] = dateOnlyMatch
    const year = Number(yearText)
    const month = Number(monthText)
    const day = Number(dayText)
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
    return new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
  }

  const parsed = Date.parse(normalizedValue)
  if (Number.isNaN(parsed)) return null
  return parsed
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

function HoverScrollText({ text, className }: { text: string; className?: string }) {
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

export default function TachesPage() {
  const router = useRouter()
  const connectedUsername = useSyncExternalStore(
    subscribeToUsernameStorage,
    readStoredUsername,
    () => ''
  )

  const [activeMenu, setActiveMenuState] = useState<ActiveMenu>('taches')
  const [activeDemandesSubMenu, setActiveDemandesSubMenuState] = useState<'nouvelle' | 'voir' | null>(null)
  const [activeConfigurationSubMenu, setActiveConfigurationSubMenuState] = useState<'taches' | null>(null)
  const [activeConfigurationTab, setActiveConfigurationTabState] = useState<'donnees' | 'historique'>('donnees')

  const [connectedUserId, setConnectedUserId] = useState<number | null>(null)
  const [connectedUserRole, setConnectedUserRole] = useState<'ADMIN' | 'EMPLOYE'>('EMPLOYE')
  const [assignedTasks, setAssignedTasks] = useState<AssignedTaskListItem[]>([])
  const [assignedTasksLoading, setAssignedTasksLoading] = useState(false)
  const [assignedTasksError, setAssignedTasksError] = useState('')
  const [tasksSearchTerm, setTasksSearchTerm] = useState('')
  const [tasksSortKey, setTasksSortKey] = useState<TasksSortKey>('title')
  const [tasksSortDirection, setTasksSortDirection] = useState<TasksSortDirection>('asc')
  const [tasksNowMs, setTasksNowMs] = useState(() => Date.now())
  const [taskCollaboratorsByTaskId, setTaskCollaboratorsByTaskId] = useState<Map<number, string[]>>(new Map())

  useEffect(() => {
    updatePersistedUiState((previousState) => ({
      ...previousState,
      activeTab: 'tab1',
      activeMenu: 'taches',
    }))
    setActiveMenuState('taches')
  }, [])

  useEffect(() => {
    let cancelled = false

    const syncSession = async () => {
      const response = await fetch('/api/auth/session', { cache: 'no-store' })
      if (!response.ok) {
        if (!cancelled) router.push('/')
        return
      }

      const sessionPayload = (await response.json()) as { role?: string }
      if (!cancelled) {
        setConnectedUserRole(sessionPayload.role === 'ADMIN' ? 'ADMIN' : 'EMPLOYE')
      }
    }

    void syncSession()
    return () => {
      cancelled = true
    }
  }, [router])

  useEffect(() => {
    if (!connectedUsername.trim()) {
      setConnectedUserId(null)
      return
    }

    let cancelled = false

    const loadConnectedUser = async () => {
      const { data, error } = await supabase
        .from('utilisateur')
        .select('id_utilisateur')
        .eq('username_utilisateur', connectedUsername)
        .single()

      if (cancelled) return
      if (error || !data) {
        setConnectedUserId(null)
        return
      }
      setConnectedUserId(data.id_utilisateur ?? null)
    }

    void loadConnectedUser()
    return () => {
      cancelled = true
    }
  }, [connectedUsername])

  useEffect(() => {
    if (connectedUserId === null) {
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

      const { data: linkRows, error: linkError } = await supabase
        .from('utilisateur_tache')
        .select('*')
        .eq('id_utilisateur', connectedUserId)

      if (cancelled) return

      if (linkError || !linkRows) {
        setAssignedTasks([])
        setAssignedTasksError("Impossible de charger les tâches.")
        setAssignedTasksLoading(false)
        return
      }

      const taskIds = Array.from(
        new Set(
          linkRows
            .map((row) => Number(row.id_tache))
            .filter((value) => Number.isFinite(value) && value > 0)
        )
      )

      if (taskIds.length === 0) {
        setAssignedTasks([])
        setTaskCollaboratorsByTaskId(new Map())
        setAssignedTasksLoading(false)
        return
      }

      const { data: taskRows, error: taskError } = await supabase
        .from('tache')
        .select('*')
        .in('id_tache', taskIds)
        .eq('actif', true)
        .neq('tache_systeme', true)
        .order('titre_tache', { ascending: true })

      if (cancelled) return

      if (taskError || !taskRows) {
        setAssignedTasks([])
        setAssignedTasksError("Impossible de charger les tâches.")
        setTaskCollaboratorsByTaskId(new Map())
        setAssignedTasksLoading(false)
        return
      }

      const deadlineByTaskId = new Map<number, number | null>(
        linkRows.map((row) => {
          const taskId = Number(row.id_tache)
          const dynamicRow = row as Record<string, unknown>
          return [taskId, parseTaskDueDateToMs(dynamicRow.date_echeance_tache)]
        })
      )

      const normalizedTasks: AssignedTaskListItem[] = taskRows
        .filter((task) => {
          const title =
            typeof task.titre_tache === 'string'
              ? task.titre_tache.trim().toLocaleLowerCase('fr-FR')
              : ''
          return title !== 'autre tâche' && title !== 'autre tache'
        })
        .map((task) => {
          const dynamicTask = task as Record<string, unknown>
          return {
            id: Number(task.id_tache),
            title:
              typeof task.titre_tache === 'string' && task.titre_tache.trim()
                ? task.titre_tache
                : 'Tâche',
            description:
              typeof dynamicTask.description_tache === 'string' && dynamicTask.description_tache.trim()
                ? dynamicTask.description_tache
                : '-',
            priorityId: Number.isFinite(Number(dynamicTask.id_priorite_tache))
              ? Number(dynamicTask.id_priorite_tache)
              : null,
            dueAtMs: deadlineByTaskId.get(Number(task.id_tache)) ?? null,
          }
        })

      const filteredTaskIds = normalizedTasks.map((task) => task.id)
      let collaboratorsByTaskId = new Map<number, string[]>()
      if (filteredTaskIds.length > 0) {
        const { data: collaboratorLinks } = await supabase
          .from('utilisateur_tache')
          .select('id_tache, id_utilisateur')
          .in('id_tache', filteredTaskIds)
          .neq('id_utilisateur', connectedUserId)

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

      setAssignedTasks(normalizedTasks)
      setTaskCollaboratorsByTaskId(collaboratorsByTaskId)
      setAssignedTasksLoading(false)
    }

    void loadAssignedTasks()

    return () => {
      cancelled = true
    }
  }, [connectedUserId])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTasksNowMs(Date.now())
    }, 1000)

    return () => window.clearInterval(timer)
  }, [])

  const filteredAssignedTasks = useMemo(() => {
    const normalizedTerm = tasksSearchTerm.trim().toLocaleLowerCase('fr-FR')
    if (!normalizedTerm) return assignedTasks
    return assignedTasks.filter((task) =>
      task.title.toLocaleLowerCase('fr-FR').includes(normalizedTerm)
    )
  }, [assignedTasks, tasksSearchTerm])

  const sortedAssignedTasks = useMemo(() => {
    const directionMultiplier = tasksSortDirection === 'asc' ? 1 : -1
    return [...filteredAssignedTasks].sort((leftTask, rightTask) => {
      if (tasksSortKey === 'title') {
        return (
          leftTask.title.localeCompare(rightTask.title, 'fr', { sensitivity: 'base' }) *
          directionMultiplier
        )
      }

      if (tasksSortKey === 'priority') {
        const leftPriority = leftTask.priorityId ?? Number.POSITIVE_INFINITY
        const rightPriority = rightTask.priorityId ?? Number.POSITIVE_INFINITY
        if (leftPriority === rightPriority) return 0
        return (leftPriority < rightPriority ? -1 : 1) * directionMultiplier
      }

      const leftDue = leftTask.dueAtMs ?? Number.POSITIVE_INFINITY
      const rightDue = rightTask.dueAtMs ?? Number.POSITIVE_INFINITY
      if (leftDue === rightDue) return 0
      return (leftDue < rightDue ? -1 : 1) * directionMultiplier
    })
  }, [filteredAssignedTasks, tasksSortDirection, tasksSortKey])

  const handleTasksSort = useCallback(
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

  const taskRemainingInfoById = useMemo(() => {
    const entries = assignedTasks.map((task) => {
      if (typeof task.dueAtMs !== 'number') {
        return [task.id, { hasDueAt: false, isLate: false, ...splitRemainingDuration(0) }] as const
      }
      const remainingMs = task.dueAtMs - tasksNowMs
      return [
        task.id,
        { hasDueAt: true, isLate: remainingMs < 0, ...splitRemainingDuration(remainingMs) },
      ] as const
    })
    return new Map(entries)
  }, [assignedTasks, tasksNowMs])

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
        <div className={styles.agendaTabStrip} role="tablist" aria-label="Vue tâches">
          <button
            type="button"
            role="tab"
            aria-selected
            className={`${styles.tabButton} ${styles.tabButtonActive}`}
          >
            Voir mes tâches
          </button>
        </div>
      }
    >
      <div className={styles.tasksWrap}>
        <div className={styles.tasksToolbar}>
          <input
            type="search"
            className={styles.tasksSearchInput}
            placeholder="Rechercher une tâche..."
            value={tasksSearchTerm}
            onChange={(event) => setTasksSearchTerm(event.target.value)}
            aria-label="Rechercher une tâche par titre"
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
                  <th>
                    <button
                      type="button"
                      className={styles.tasksSortButton}
                      onClick={() => handleTasksSort('title')}
                    >
                      TÂCHE
                      {tasksSortKey === 'title' ? (tasksSortDirection === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  </th>
                  <th>DESCRIPTION</th>
                  <th>
                    <button
                      type="button"
                      className={styles.tasksSortButton}
                      onClick={() => handleTasksSort('priority')}
                    >
                      PRIORITÉ
                      {tasksSortKey === 'priority' ? (tasksSortDirection === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      className={styles.tasksSortButton}
                      onClick={() => handleTasksSort('deadline')}
                    >
                      DÉLAI
                      {tasksSortKey === 'deadline' ? (tasksSortDirection === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  </th>
                  <th>ÉQUIPE</th>
                </tr>
              </thead>
              <tbody>
                {sortedAssignedTasks.map((task) => (
                  <tr key={`assigned-task-${task.id}`}>
                    <td className={styles.taskTitleCell}>
                      <HoverScrollText text={task.title} />
                    </td>
                    <td className={styles.taskDescriptionCell}>
                      <HoverScrollText text={task.description} />
                    </td>
                    <td className={styles.taskPriorityCell}>
                      <div className={styles.priorityGauge}>
                        <div
                          className={styles.priorityGaugeCursor}
                          style={{ left: `${getPriorityCursorPercent(task.priorityId)}%` }}
                        />
                      </div>
                    </td>
                    <td
                      className={`${styles.taskDurationCell} ${
                        taskRemainingInfoById.get(task.id)?.isLate
                          ? styles.taskDurationLate
                          : styles.taskDurationOnTime
                      }`}
                    >
                      {(() => {
                        const duration = taskRemainingInfoById.get(task.id)
                        if (!duration?.hasDueAt) return '--'
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
                        <span className={styles.taskUsersTrigger} title="Voir les utilisateurs assignés">
                          👤
                        </span>
                        <div className={styles.taskUsersMenu}>
                          {(() => {
                            const collaborators = taskCollaboratorsByTaskId.get(task.id) ?? []
                            const members = ['VOUS', ...collaborators]
                            return members.length === 0 ? (
                              <p className={styles.taskUsersEmpty}>Aucun autre membre</p>
                            ) : (
                              <ul className={styles.taskUsersList}>
                                {members.map((userName) => (
                                  <li key={`${task.id}-${userName}`} className={styles.taskUsersItem}>
                                    {userName}
                                  </li>
                                ))}
                              </ul>
                            )
                          })()}
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
    </AppShell>
  )
}
