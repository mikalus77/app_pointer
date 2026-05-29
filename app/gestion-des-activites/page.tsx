'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { useRouter } from 'next/navigation'
import { AppShell } from '../../components/app-shell'
import type { ShellNavigationOptions, ActiveMenu } from '../../lib/app-ui-state'
import {
  CONNECTED_USERNAME_CHANGED_EVENT,
  CONNECTED_USERNAME_STORAGE_KEY,
  readStoredUsername,
  subscribeToUsernameStorage,
  updatePersistedUiState,
} from '../../lib/app-ui-state'
import { supabase } from '../../lib/supabase'
import styles from './page.module.css'

type TasksSortKey = 'title' | 'priority'
type TasksSortDirection = 'asc' | 'desc'
type TaskStatusTab = 'EN_COURS' | 'REUSSIE' | 'ECHOUEE'
type TaskFormMode = 'add' | 'edit' | null
type AssignmentMode = 'add' | 'edit' | null

type TaskListItem = {
  id: number
  title: string
  description: string
  priorityId: number | null
  creatorId: number | null
  creatorName: string
  createdAt: string | null
}

type PriorityOption = {
  id: number
  label: string
}

type AssignmentUserItem = {
  id: number
  firstName: string
  lastName: string
  fullName: string
  selected: boolean
  dueDate: string
  originallySelected: boolean
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

function formatTaskCreatedAt(value: string | null) {
  if (!value) return '-'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '-'
  const date = parsed.toLocaleDateString('fr-FR')
  const time = parsed.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  return `${date} - ${time}`
}

export default function GestionActivitesPage() {
  const router = useRouter()
  const connectedUsername = useSyncExternalStore(
    subscribeToUsernameStorage,
    readStoredUsername,
    () => ''
  )

  const [activeMenu, setActiveMenuState] = useState<ActiveMenu>('gestion_taches')
  const [activeDemandesSubMenu, setActiveDemandesSubMenuState] = useState<'nouvelle' | 'voir' | null>(
    null
  )
  const [activeConfigurationSubMenu, setActiveConfigurationSubMenuState] = useState<'taches' | null>(
    null
  )
  const [activeConfigurationTab, setActiveConfigurationTabState] = useState<'donnees' | 'historique'>(
    'donnees'
  )

  const [allTasks, setAllTasks] = useState<TaskListItem[]>([])
  const [allTasksLoading, setAllTasksLoading] = useState(false)
  const [allTasksError, setAllTasksError] = useState('')
  const [tasksSearchTerm, setTasksSearchTerm] = useState('')
  const [tasksSortKey, setTasksSortKey] = useState<TasksSortKey>('title')
  const [tasksSortDirection, setTasksSortDirection] = useState<TasksSortDirection>('asc')
  const [taskStatusTab, setTaskStatusTab] = useState<TaskStatusTab>('EN_COURS')
  const [taskCollaboratorsByTaskId, setTaskCollaboratorsByTaskId] = useState<Map<number, string[]>>(new Map())

  const [deleteTaskTarget, setDeleteTaskTarget] = useState<TaskListItem | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [deletePending, setDeletePending] = useState(false)
  const [taskFormMode, setTaskFormMode] = useState<TaskFormMode>(null)
  const [taskFormTarget, setTaskFormTarget] = useState<TaskListItem | null>(null)
  const [taskFormTitle, setTaskFormTitle] = useState('')
  const [taskFormDescription, setTaskFormDescription] = useState('')
  const [taskFormPriorityId, setTaskFormPriorityId] = useState<number | ''>('')
  const [priorityOptions, setPriorityOptions] = useState<PriorityOption[]>([])
  const [taskFormPending, setTaskFormPending] = useState(false)
  const [taskFormError, setTaskFormError] = useState('')
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>(null)
  const [assignmentTaskId, setAssignmentTaskId] = useState<number | null>(null)
  const [assignmentSearchTerm, setAssignmentSearchTerm] = useState('')
  const [assignmentUsers, setAssignmentUsers] = useState<AssignmentUserItem[]>([])
  const [assignmentLoading, setAssignmentLoading] = useState(false)
  const [assignmentPending, setAssignmentPending] = useState(false)
  const [assignmentError, setAssignmentError] = useState('')
  const [connectedUserId, setConnectedUserId] = useState<number | null>(null)
  const [connectedUserRole, setConnectedUserRole] = useState<'ADMIN' | 'EMPLOYE'>('EMPLOYE')

  useEffect(() => {
    updatePersistedUiState((previousState) => ({
      ...previousState,
      activeTab: 'tab1',
      activeMenu: 'gestion_taches',
    }))
    setActiveMenuState('gestion_taches')
  }, [])

  useEffect(() => {
    let cancelled = false

    const syncSession = async () => {
      const response = await fetch('/api/auth/session', { cache: 'no-store' })
      if (!response.ok) {
        if (!cancelled) router.push('/')
        return
      }

      try {
        const payload = (await response.json()) as { userId?: number; role?: string }
        if (!cancelled && typeof payload.userId === 'number' && Number.isFinite(payload.userId)) {
          setConnectedUserId(payload.userId)
        }
        if (!cancelled) {
          setConnectedUserRole(payload.role === 'ADMIN' ? 'ADMIN' : 'EMPLOYE')
        }
      } catch {
        if (!cancelled) setConnectedUserId(null)
      }
    }

    void syncSession()
    return () => {
      cancelled = true
    }
  }, [router])

  const loadTasks = useCallback(async () => {
    setAllTasksLoading(true)
    setAllTasksError('')
    const { data: statusRow, error: statusError } = await supabase
      .from('statut_tache')
      .select('id_statut_tache')
      .eq('code_statut_tache', taskStatusTab)
      .single()

    if (statusError || !statusRow) {
      setAllTasks([])
      setTaskCollaboratorsByTaskId(new Map())
      setAllTasksError(`Le statut ${taskStatusTab} est introuvable !`)
      setAllTasksLoading(false)
      return
    }

    const { data: tasksData, error: tasksError } = await supabase
      .from('tache')
      .select('*')
      .eq('id_statut_tache', statusRow.id_statut_tache)
      .neq('tache_systeme', true)
      .order('titre_tache', { ascending: true })

    if (tasksError || !tasksData) {
      setAllTasks([])
      setTaskCollaboratorsByTaskId(new Map())
      setAllTasksError('Impossible de charger les tâches !')
      setAllTasksLoading(false)
      return
    }

    const normalizedTasksBase: TaskListItem[] = tasksData.map((task) => {
      const dynamicTask = task as Record<string, unknown>
      const rawCreatorId =
        dynamicTask.id_createur_tache ?? dynamicTask.id_utilisateur_createur ?? null
      const creatorId = Number.isFinite(Number(rawCreatorId)) ? Number(rawCreatorId) : null
      const rawCreatedAt = dynamicTask.date_creation_tache

      return {
        id: Number(dynamicTask.id_tache),
        title:
          typeof dynamicTask.titre_tache === 'string' && dynamicTask.titre_tache.trim()
            ? dynamicTask.titre_tache
            : 'Tâche sans titre',
        description:
          typeof dynamicTask.description_tache === 'string' && dynamicTask.description_tache.trim()
            ? dynamicTask.description_tache
            : '-',
        priorityId: Number.isFinite(Number(dynamicTask.id_priorite_tache))
          ? Number(dynamicTask.id_priorite_tache)
          : null,
        creatorId,
        creatorName: '-',
        createdAt:
          typeof rawCreatedAt === 'string' && rawCreatedAt.trim() ? rawCreatedAt : null,
      }
    })

    const creatorIds = Array.from(
      new Set(
        normalizedTasksBase
          .map((task) => task.creatorId)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      )
    )

    const creatorNameById = new Map<number, string>()
    if (creatorIds.length > 0) {
      const { data: creatorRows } = await supabase
        .from('utilisateur')
        .select('id_utilisateur, prenom_utilisateur, nom_utilisateur')
        .in('id_utilisateur', creatorIds)

      for (const creator of creatorRows ?? []) {
        const fullName =
          `${(creator.prenom_utilisateur ?? '').trim()} ${(creator.nom_utilisateur ?? '').trim()}`.trim() ||
          '-'
        creatorNameById.set(Number(creator.id_utilisateur), fullName)
      }
    }

    const normalizedTasks: TaskListItem[] = normalizedTasksBase.map((task) => ({
      ...task,
      creatorName: task.creatorId !== null ? creatorNameById.get(task.creatorId) ?? '-' : '-',
    }))

    const taskIds = normalizedTasks.map((task) => task.id)
    let collaboratorsByTaskId = new Map<number, string[]>()
    if (taskIds.length > 0) {
      const { data: collaboratorLinks } = await supabase
        .from('utilisateur_tache')
        .select('id_tache, id_utilisateur')
        .in('id_tache', taskIds)

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

    for (const task of normalizedTasks) {
      const existing = collaboratorsByTaskId.get(task.id) ?? []
      collaboratorsByTaskId.set(
        task.id,
        [...existing].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }))
      )
    }

    setAllTasks(normalizedTasks)
    setTaskCollaboratorsByTaskId(collaboratorsByTaskId)
    setAllTasksLoading(false)
  }, [taskStatusTab])

  useEffect(() => {
    void loadTasks()
  }, [loadTasks])

  const loadPriorityOptions = useCallback(async () => {
    const { data, error } = await supabase
      .from('priorite_tache')
      .select('*')
      .eq('actif', true)
      .order('id_priorite_tache', { ascending: true })

    if (error || !data) {
      setPriorityOptions([])
      return
    }

    const options = data
      .map((row) => {
        const dynamicRow = row as Record<string, unknown>
        const id = Number(dynamicRow.id_priorite_tache)
        if (!Number.isFinite(id)) return null
        const labelCandidate = [
          dynamicRow.libelle_priorite_tache,
          dynamicRow.nom_priorite_tache,
          dynamicRow.code_priorite_tache,
          dynamicRow.titre_priorite_tache,
        ].find((value) => typeof value === 'string' && value.trim().length > 0)
        return {
          id,
          label: (labelCandidate as string | undefined)?.trim() || `Priorité ${id}`,
        }
      })
      .filter((item): item is PriorityOption => item !== null)

    setPriorityOptions(options)
  }, [])

  useEffect(() => {
    void loadPriorityOptions()
  }, [loadPriorityOptions])

  const playDeletePromptTone = useCallback(() => {
    if (typeof window === 'undefined') return
    try {
      const AudioContextClass =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextClass) return
      const ctx = new AudioContextClass()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(680, ctx.currentTime)
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.3)
      void ctx.close()
    } catch {
      // ignore
    }
  }, [])

  const openDeleteModal = useCallback(
    (task: TaskListItem) => {
      setDeleteTaskTarget(task)
      setDeleteError('')
      setDeletePending(false)
      playDeletePromptTone()
    },
    [playDeletePromptTone]
  )

  const closeDeleteModal = useCallback(() => {
    setDeleteTaskTarget(null)
    setDeleteError('')
    setDeletePending(false)
  }, [])

  const handleConfirmDeleteTask = useCallback(async () => {
    if (!deleteTaskTarget || deletePending) return

    setDeletePending(true)
    setDeleteError('')

    const { error: unlinkError } = await supabase
      .from('utilisateur_tache')
      .delete()
      .eq('id_tache', deleteTaskTarget.id)

    if (unlinkError) {
      setDeletePending(false)
      setDeleteError(unlinkError.message || 'Impossible de supprimer cette tâche !')
      return
    }

    const { error: deleteErrorResult } = await supabase
      .from('tache')
      .delete()
      .eq('id_tache', deleteTaskTarget.id)
      .neq('tache_systeme', true)

    if (deleteErrorResult) {
      setDeletePending(false)
      setDeleteError(deleteErrorResult.message || 'Impossible de supprimer cette tâche !')
      return
    }

    closeDeleteModal()
    await loadTasks()
  }, [closeDeleteModal, deletePending, deleteTaskTarget, loadTasks])

  const closeTaskFormModal = useCallback(() => {
    setTaskFormMode(null)
    setTaskFormTarget(null)
    setTaskFormTitle('')
    setTaskFormDescription('')
    setTaskFormPriorityId('')
    setTaskFormPending(false)
    setTaskFormError('')
  }, [])

  const openAddTaskModal = useCallback(() => {
    setTaskFormMode('add')
    setTaskFormTarget(null)
    setTaskFormTitle('')
    setTaskFormDescription('')
    setTaskFormPriorityId(priorityOptions[0]?.id ?? '')
    setTaskFormPending(false)
    setTaskFormError('')
  }, [priorityOptions])

  const openEditTaskModal = useCallback((task: TaskListItem) => {
    setTaskFormMode('edit')
    setTaskFormTarget(task)
    setTaskFormTitle(task.title)
    setTaskFormDescription(task.description === '-' ? '' : task.description)
    setTaskFormPriorityId(task.priorityId ?? '')
    setTaskFormPending(false)
    setTaskFormError('')
  }, [])

  const handleSubmitTaskForm = useCallback(async () => {
    if (!taskFormMode || taskFormPending) return

    const normalizedTitle = taskFormTitle.trim()
    if (!normalizedTitle) {
      setTaskFormError('Veuillez renseigner le titre de la tâche !')
      return
    }
    if (!taskFormPriorityId) {
      setTaskFormError('Veuillez sélectionner une priorité !')
      return
    }

    setTaskFormPending(true)
    setTaskFormError('')

    const payload = {
      titre_tache: normalizedTitle,
      description_tache: taskFormDescription.trim() || null,
      id_priorite_tache: Number(taskFormPriorityId),
    }

    if (taskFormMode === 'add') {
      const { data: enCoursStatusRow, error: enCoursStatusError } = await supabase
        .from('statut_tache')
        .select('id_statut_tache')
        .eq('code_statut_tache', 'EN_COURS')
        .single()

      if (enCoursStatusError || !enCoursStatusRow) {
        setTaskFormPending(false)
        setTaskFormError('Le statut EN_COURS est introuvable !')
        return
      }
      const creatorId =
        typeof connectedUserId === 'number' && Number.isFinite(connectedUserId)
          ? connectedUserId
          : null

      const createTask = async (creatorColumn: 'id_utilisateur_createur' | 'id_createur_tache') => {
        const insertPayload = creatorId
          ? { ...payload, id_statut_tache: enCoursStatusRow.id_statut_tache, [creatorColumn]: creatorId }
          : { ...payload, id_statut_tache: enCoursStatusRow.id_statut_tache }
        return supabase.from('tache').insert(insertPayload).select('id_tache').single()
      }

      let { data, error } = await createTask('id_utilisateur_createur')
      if (error && /column .*id_utilisateur_createur.* does not exist/i.test(error.message)) {
        const retried = await createTask('id_createur_tache')
        data = retried.data
        error = retried.error
      }

      if (error) {
        setTaskFormPending(false)
        setTaskFormError(error.message || "Impossible d'ajouter la tâche !")
        return
      }

      const createdTaskId = Number(data?.id_tache)
      if (!Number.isFinite(createdTaskId)) {
        setTaskFormPending(false)
        setTaskFormError("Impossible d'ajouter la tâche !")
        return
      }
      closeTaskFormModal()
      setAssignmentMode('add')
      setAssignmentTaskId(createdTaskId)
      setAssignmentSearchTerm('')
      setAssignmentError('')
      setAssignmentPending(false)
      setTaskFormPending(false)
      await loadTasks()
      return
    } else {
      if (!taskFormTarget) {
        setTaskFormPending(false)
        setTaskFormError('Tâche introuvable !')
        return
      }

      const { error } = await supabase
        .from('tache')
        .update(payload)
        .eq('id_tache', taskFormTarget.id)
      if (error) {
        setTaskFormPending(false)
        setTaskFormError('Impossible de modifier la tâche !')
        return
      }

      closeTaskFormModal()
      setAssignmentMode('edit')
      setAssignmentTaskId(taskFormTarget.id)
      setAssignmentSearchTerm('')
      setAssignmentError('')
      setAssignmentPending(false)
      setTaskFormPending(false)
      await loadTasks()
      return
    }
  }, [
    closeTaskFormModal,
    loadTasks,
    taskFormDescription,
    taskFormMode,
    taskFormPending,
    taskFormPriorityId,
    taskFormTarget,
    taskFormTitle,
    connectedUserId,
  ])

  const closeAssignmentModal = useCallback(() => {
    setAssignmentMode(null)
    setAssignmentTaskId(null)
    setAssignmentSearchTerm('')
    setAssignmentUsers([])
    setAssignmentLoading(false)
    setAssignmentPending(false)
    setAssignmentError('')
  }, [])

  useEffect(() => {
    if (!assignmentMode || !assignmentTaskId) return
    let cancelled = false

    const loadAssignmentUsers = async () => {
      setAssignmentLoading(true)
      setAssignmentError('')

      const { data: userRows, error: userError } = await supabase
        .from('utilisateur')
        .select(
          'id_utilisateur, prenom_utilisateur, nom_utilisateur, id_statut_utilisateur!inner(code_statut_utilisateur)'
        )
        .order('prenom_utilisateur', { ascending: true })
        .order('nom_utilisateur', { ascending: true })

      if (userError || !userRows) {
        if (!cancelled) {
          setAssignmentUsers([])
          setAssignmentLoading(false)
          setAssignmentError('Impossible de charger les utilisateurs !')
        }
        return
      }

      const activeUsersBase = userRows.filter((row) => {
        const joined = row.id_statut_utilisateur as unknown as { code_statut_utilisateur?: string } | null
        const code = (joined?.code_statut_utilisateur ?? '').toString().trim().toUpperCase()
        return code === 'ACTIVE'
      })

      const activeUsers = activeUsersBase.map((row) => ({
        id: Number(row.id_utilisateur),
        firstName: (row.prenom_utilisateur ?? '').trim(),
        lastName: (row.nom_utilisateur ?? '').trim(),
      }))

      const { data: assignmentsData } = await supabase
        .from('utilisateur_tache')
        .select('id_utilisateur, date_echeance_tache')
        .eq('id_tache', assignmentTaskId)

      const assignmentByUserId = new Map<number, string>()
      for (const assignment of assignmentsData ?? []) {
        const userId = Number(assignment.id_utilisateur)
        if (!Number.isFinite(userId)) continue
        const due =
          typeof assignment.date_echeance_tache === 'string' ? assignment.date_echeance_tache.slice(0, 10) : ''
        assignmentByUserId.set(userId, due)
      }

      const mapped = activeUsers.map((user) => {
        const fullName = `${user.firstName} ${user.lastName}`.trim() || `Utilisateur #${user.id}`
        const assignedDue = assignmentByUserId.get(user.id) ?? ''
        const selected = assignmentByUserId.has(user.id)
        return {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName,
          selected,
          dueDate: assignedDue,
          originallySelected: selected,
        } satisfies AssignmentUserItem
      })

      mapped.sort((a, b) => {
        if (a.selected !== b.selected) return a.selected ? -1 : 1
        return a.fullName.localeCompare(b.fullName, 'fr', { sensitivity: 'base' })
      })

      if (!cancelled) {
        setAssignmentUsers(mapped)
        setAssignmentLoading(false)
      }
    }

    void loadAssignmentUsers()
    return () => {
      cancelled = true
    }
  }, [assignmentMode, assignmentTaskId])

  const toggleAssignmentUser = useCallback((userId: number) => {
    setAssignmentUsers((previous) =>
      previous.map((user) =>
        user.id === userId
          ? {
              ...user,
              selected: !user.selected,
              dueDate: user.selected ? '' : user.dueDate,
            }
          : user
      )
    )
  }, [])

  const changeAssignmentDueDate = useCallback((userId: number, value: string) => {
    setAssignmentUsers((previous) =>
      previous.map((user) => (user.id === userId ? { ...user, dueDate: value } : user))
    )
  }, [])

  const handleSubmitAssignments = useCallback(async () => {
    if (!assignmentTaskId || assignmentPending) return
    setAssignmentPending(true)
    setAssignmentError('')

    const selectedUsers = assignmentUsers.filter((user) => user.selected)
    const selectedUserIds = selectedUsers.map((user) => user.id)

    const rowsToUpsert = selectedUsers.map((user) => ({
      id_tache: assignmentTaskId,
      id_utilisateur: user.id,
      date_echeance_tache: user.dueDate || null,
    }))

    if (rowsToUpsert.length > 0) {
      const { error: upsertError } = await supabase
        .from('utilisateur_tache')
        .upsert(rowsToUpsert, { onConflict: 'id_tache,id_utilisateur' })
      if (upsertError) {
        setAssignmentPending(false)
        setAssignmentError("Impossible d'appliquer les affectations !")
        return
      }
    }

    const { data: existingLinks } = await supabase
      .from('utilisateur_tache')
      .select('id_utilisateur')
      .eq('id_tache', assignmentTaskId)

    const idsToDelete = (existingLinks ?? [])
      .map((link) => Number(link.id_utilisateur))
      .filter((id) => Number.isFinite(id) && !selectedUserIds.includes(id))

    if (idsToDelete.length > 0) {
      const { error: deleteError } = await supabase
        .from('utilisateur_tache')
        .delete()
        .eq('id_tache', assignmentTaskId)
        .in('id_utilisateur', idsToDelete)
      if (deleteError) {
        setAssignmentPending(false)
        setAssignmentError("Impossible d'appliquer les affectations !")
        return
      }
    }

    closeAssignmentModal()
    await loadTasks()
  }, [assignmentPending, assignmentTaskId, assignmentUsers, closeAssignmentModal, loadTasks])

  const filteredTasks = useMemo(() => {
    const normalizedTerm = tasksSearchTerm.trim().toLocaleLowerCase('fr-FR')
    if (!normalizedTerm) return allTasks
    return allTasks.filter((task) => task.title.toLocaleLowerCase('fr-FR').includes(normalizedTerm))
  }, [allTasks, tasksSearchTerm])

  const sortedTasks = useMemo(() => {
    const directionMultiplier = tasksSortDirection === 'asc' ? 1 : -1
    return [...filteredTasks].sort((leftTask, rightTask) => {
      if (tasksSortKey === 'title') {
        return (
          leftTask.title.localeCompare(rightTask.title, 'fr', { sensitivity: 'base' }) *
          directionMultiplier
        )
      }

      const leftPriority = leftTask.priorityId ?? Number.POSITIVE_INFINITY
      const rightPriority = rightTask.priorityId ?? Number.POSITIVE_INFINITY
      if (leftPriority === rightPriority) return 0
      return (leftPriority < rightPriority ? -1 : 1) * directionMultiplier
    })
  }, [filteredTasks, tasksSortDirection, tasksSortKey])

  const filteredAssignmentUsers = useMemo(() => {
    const term = assignmentSearchTerm.trim().toLocaleLowerCase('fr-FR')
    const source = [...assignmentUsers].sort((a, b) => {
      if (a.selected !== b.selected) return a.selected ? -1 : 1
      return a.fullName.localeCompare(b.fullName, 'fr', { sensitivity: 'base' })
    })
    if (!term) return source
    return source.filter((user) => user.fullName.toLocaleLowerCase('fr-FR').includes(term))
  }, [assignmentSearchTerm, assignmentUsers])

  const toggleTasksSort = useCallback(
    (key: TasksSortKey) => {
      if (tasksSortKey === key) {
        setTasksSortDirection((previousDirection) => (previousDirection === 'asc' ? 'desc' : 'asc'))
        return
      }
      setTasksSortKey(key)
      setTasksSortDirection('asc')
    },
    [tasksSortKey]
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

  return (
    <>
      <AppShell
        connectedUsername={connectedUsername}
        userRole={connectedUserRole}
        activeTab="tab1"
        activeMenu={activeMenu}
        activeDemandesSubMenu={activeDemandesSubMenu}
        activeConfigurationSubMenu={activeConfigurationSubMenu}
        activeConfigurationTab={activeConfigurationTab}
        onTabChange={(tab) => {
          if (tab === 'tab2') {
            router.push('/utilisateurs')
          }
        }}
        onOpenAgenda={openAgendaPage}
        onOpenPointage={openPointagePage}
        onOpenMenu={openShellPage}
        onConfigurationSubMenuChange={setActiveConfigurationSubMenuState}
        onConfigurationTabChange={setActiveConfigurationTabState}
        onLogout={handleLogout}
        middleContent={
          <div className={styles.agendaTabStrip} role="tablist" aria-label="Vue gestion des tâches">
            <button
              type="button"
              role="tab"
              aria-selected={taskStatusTab === 'EN_COURS'}
              className={`${styles.tabButton} ${taskStatusTab === 'EN_COURS' ? styles.tabButtonActive : ''}`}
              onClick={() => setTaskStatusTab('EN_COURS')}
            >
              Tâches en cours
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={taskStatusTab === 'REUSSIE'}
              className={`${styles.tabButton} ${taskStatusTab === 'REUSSIE' ? styles.tabButtonActive : ''}`}
              onClick={() => setTaskStatusTab('REUSSIE')}
            >
              Tâches réussies
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={taskStatusTab === 'ECHOUEE'}
              className={`${styles.tabButton} ${taskStatusTab === 'ECHOUEE' ? styles.tabButtonActive : ''}`}
              onClick={() => setTaskStatusTab('ECHOUEE')}
            >
              Tâches échouées
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
            {taskStatusTab === 'EN_COURS' ? (
              <button type="button" className={styles.addTaskButton} onClick={openAddTaskModal}>
                ajouter une tâche
              </button>
            ) : null}
          </div>
          <div className={styles.tasksBody}>
            {allTasksLoading ? (
              <div className={styles.tasksEmptyState}>
                <p className={styles.tasksStateText}>Chargement des tâches...</p>
              </div>
            ) : allTasksError ? (
              <div className={styles.tasksEmptyState}>
                <p className={styles.tasksStateText}>{allTasksError}</p>
              </div>
            ) : sortedTasks.length === 0 ? (
              <div className={styles.tasksEmptyState}>
                <p className={styles.tasksStateText}>
                  {taskStatusTab === 'REUSSIE'
                    ? 'Aucune tâche réussie'
                    : taskStatusTab === 'ECHOUEE'
                      ? 'Aucune tâche échouée'
                      : 'Aucune tâche affectée'}
                </p>
              </div>
            ) : (
              <table
                className={`${styles.tasksTable} ${taskStatusTab === 'EN_COURS' ? styles.tasksTableSharp : ''}`}
              >
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
                    <th scope="col">ÉQUIPE</th>
                    <th scope="col">ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTasks.map((task) => (
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
                      <td className={styles.actionsCell}>
                        <div className={styles.actionButtons}>
                          <div className={styles.taskInfoWrap}>
                            <span
                              className={`${styles.actionButton} ${styles.actionButtonInfo}`}
                              title="Informations"
                              aria-label="Informations"
                            >
                              ℹ️
                            </span>
                            <div className={styles.taskInfoMenu}>
                              <p className={styles.taskInfoLine}>
                                <span className={styles.taskInfoLabel}>Créée par :</span>{' '}
                                <span className={styles.taskInfoValue}>{task.creatorName}</span>
                              </p>
                              <p className={styles.taskInfoLine}>
                                <span className={styles.taskInfoLabel}>Créée le :</span>{' '}
                                <span className={styles.taskInfoValue}>{formatTaskCreatedAt(task.createdAt).split(' - ')[0] ?? '-'}</span>
                              </p>
                              <p className={styles.taskInfoLine}>
                                <span className={styles.taskInfoLabel}>Créée à :</span>{' '}
                                <span className={styles.taskInfoValue}>{formatTaskCreatedAt(task.createdAt).split(' - ')[1] ?? '-'}</span>
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            className={`${styles.actionButton} ${styles.actionButtonEdit}`}
                            title="Modifier"
                            aria-label="Modifier"
                            onClick={() => openEditTaskModal(task)}
                          >
                            ✏️
                          </button>
                          <button
                            type="button"
                            className={`${styles.actionButton} ${styles.actionButtonDelete}`}
                            title="Supprimer"
                            aria-label="Supprimer"
                            onClick={() => openDeleteModal(task)}
                          >
                            ❌
                          </button>
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

      {deleteTaskTarget ? (
        <div className={styles.deleteOverlay} onClick={closeDeleteModal}>
          <div
            className={styles.deleteModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Confirmation suppression"
          >
            <div className={styles.deleteModalHead}>Jarvis Time</div>
            <div className={styles.deleteModalBody}>
              <p className={styles.deleteText}>Voulez vous supprimer cette tâche ?</p>
              {deleteError ? <p className={styles.deleteError}>{deleteError}</p> : null}
              <div className={styles.deleteActions}>
                <button
                  type="button"
                  className={`${styles.deleteCta} ${styles.deleteDanger}`}
                  onClick={() => void handleConfirmDeleteTask()}
                  disabled={deletePending}
                >
                  {deletePending ? 'SUPPRESSION...' : 'SUPPRIMER'}
                </button>
                <button
                  type="button"
                  className={`${styles.deleteCta} ${styles.deleteCancel}`}
                  onClick={closeDeleteModal}
                  disabled={deletePending}
                >
                  ANNULER
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {taskFormMode ? (
        <div className={styles.deleteOverlay} onClick={closeTaskFormModal}>
          <div
            className={styles.taskFormModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={taskFormMode === 'add' ? 'Ajouter une tâche' : 'Modifier une tâche'}
          >
            <div className={styles.deleteModalHead}>Jarvis Time</div>
            <div className={styles.taskFormBody}>
              <div className={styles.taskFormField}>
                <label htmlFor="task-form-title" className={styles.taskFormLabel}>
                  Tâche
                </label>
                <input
                  id="task-form-title"
                  className={styles.taskFormInput}
                  type="text"
                  value={taskFormTitle}
                  onChange={(event) => setTaskFormTitle(event.target.value)}
                  placeholder="Titre de la tâche"
                />
              </div>

              <div className={styles.taskFormField}>
                <label htmlFor="task-form-description" className={styles.taskFormLabel}>
                  Description
                </label>
                <textarea
                  id="task-form-description"
                  className={styles.taskFormTextarea}
                  value={taskFormDescription}
                  onChange={(event) => setTaskFormDescription(event.target.value)}
                  placeholder="Description de la tâche"
                  rows={4}
                />
              </div>

              <div className={styles.taskFormGrid}>
                <div className={styles.taskFormField}>
                  <label htmlFor="task-form-priority" className={styles.taskFormLabel}>
                    Priorité
                  </label>
                  <select
                    id="task-form-priority"
                    className={styles.taskFormSelect}
                    value={taskFormPriorityId}
                    onChange={(event) => {
                      const value = event.target.value
                      setTaskFormPriorityId(value ? Number(value) : '')
                    }}
                  >
                    <option value="">Sélectionner</option>
                    {priorityOptions.map((priority) => (
                      <option key={priority.id} value={priority.id}>
                        {priority.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {taskFormError ? <p className={styles.deleteError}>{taskFormError}</p> : null}

              <div className={styles.deleteActions}>
                <button
                  type="button"
                  className={`${styles.deleteCta} ${
                    taskFormMode === 'add' ? styles.taskFormAddCta : styles.taskFormEditCta
                  }`}
                  onClick={() => void handleSubmitTaskForm()}
                  disabled={taskFormPending}
                >
                  {taskFormMode === 'add'
                    ? taskFormPending
                      ? 'AJOUT...'
                      : 'AJOUTER'
                    : taskFormPending
                      ? 'MODIFICATION...'
                      : 'MODIFIER'}
                </button>
                <button
                  type="button"
                  className={`${styles.deleteCta} ${styles.deleteCancel}`}
                  onClick={closeTaskFormModal}
                  disabled={taskFormPending}
                >
                  ANNULER
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {assignmentMode && assignmentTaskId ? (
        <div className={styles.deleteOverlay} onClick={closeAssignmentModal}>
          <div
            className={styles.assignmentModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={assignmentMode === 'add' ? "Affecter la tâche créée" : 'Affecter la tâche modifiée'}
          >
            <button
              type="button"
              className={styles.assignmentClose}
              aria-label="Fermer"
              onClick={closeAssignmentModal}
            >
              ×
            </button>
            <div className={styles.deleteModalHead}>Jarvis Time</div>
            <div className={styles.assignmentBody}>
              <input
                type="search"
                className={styles.tasksSearchInput}
                placeholder="Rechercher un utilisateur..."
                value={assignmentSearchTerm}
                onChange={(event) => setAssignmentSearchTerm(event.target.value)}
              />

              <div className={styles.assignmentList}>
                {assignmentLoading ? (
                  <p className={styles.tasksStateText}>Chargement des utilisateurs...</p>
                ) : filteredAssignmentUsers.length === 0 ? (
                  <p className={styles.tasksStateText}>Aucun utilisateur</p>
                ) : (
                  filteredAssignmentUsers.map((user) => (
                    <div key={user.id} className={styles.assignmentRow}>
                      <p className={styles.assignmentUserName}>{user.fullName}</p>
                      <div className={styles.assignmentControls}>
                        <button
                          type="button"
                          className={`${styles.assignmentToggle} ${
                            user.selected ? styles.assignmentToggleRemove : styles.assignmentToggleAdd
                          }`}
                          onClick={() => toggleAssignmentUser(user.id)}
                        >
                          {user.selected ? 'retirer' : 'affecter'}
                        </button>
                        {user.selected ? (
                          <input
                            type="date"
                            className={styles.assignmentDateInput}
                            value={user.dueDate}
                            onChange={(event) => changeAssignmentDueDate(user.id, event.target.value)}
                          />
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {assignmentError ? <p className={styles.deleteError}>{assignmentError}</p> : null}

              <div className={styles.assignmentFooter}>
                <button
                  type="button"
                  className={`${styles.deleteCta} ${styles.taskFormEditCta}`}
                  onClick={() => void handleSubmitAssignments()}
                  disabled={assignmentPending || assignmentLoading}
                >
                  {assignmentPending ? 'VALIDATION...' : 'VALIDER'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
