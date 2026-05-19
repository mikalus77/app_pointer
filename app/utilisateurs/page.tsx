'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
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
  const [usersTabList, setUsersTabList] = useState<
    Array<{ id: number; firstName: string; lastName: string }>
  >([])
  const [usersTabLoading, setUsersTabLoading] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)

  const { activeMenu, activeDemandesSubMenu, activeConfigurationSubMenu, activeConfigurationTab } =
    uiState

  useEffect(() => {
    let cancelled = false

    const syncSession = async () => {
      const response = await fetch('/api/auth/session', { cache: 'no-store' })
      if (!response.ok) {
        if (!cancelled) router.replace('/')
        return
      }

      const payload = (await response.json()) as { userId?: number; user?: { id?: number } }
      const userId = Number(payload.userId ?? payload.user?.id ?? NaN)
      if (!cancelled) {
        setConnectedUserId(Number.isFinite(userId) ? userId : null)
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
        .select('id_utilisateur, prenom_utilisateur, nom_utilisateur')
        .eq('actif', true)
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
      }))

      setUsersTabList(normalizedUsers)
      setSelectedUserId((previous) => {
        if (previous !== null && normalizedUsers.some((user) => user.id === previous)) {
          return previous
        }
        return normalizedUsers.length > 0 ? normalizedUsers[0].id : null
      })
      setUsersTabLoading(false)
    }

    void loadUsers()
    return () => {
      cancelled = true
    }
  }, [connectedUserId])

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

      if (menu === 'accueil') {
        router.push('/accueil')
      } else if (menu === 'pointer') {
        router.push('/pointage')
      }
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
    <AppShell
      connectedUsername={connectedUsername}
      activeTab="tab2"
      activeMenu={activeMenu}
      activeDemandesSubMenu={activeDemandesSubMenu}
      activeConfigurationSubMenu={activeConfigurationSubMenu}
      activeConfigurationTab={activeConfigurationTab}
      onTabChange={(tab) => {
        if (tab === 'tab1') {
          openAgendaPage()
        }
      }}
      onOpenAgenda={openAgendaPage}
      onOpenPointage={openPointagePage}
      onOpenMenu={openShellPage}
      onConfigurationSubMenuChange={(value) =>
        updatePersistedUiState((previousState) => ({
          ...previousState,
          activeConfigurationSubMenu: value,
        }))
      }
      onConfigurationTabChange={(value) =>
        updatePersistedUiState((previousState) => ({
          ...previousState,
          activeConfigurationTab: value,
        }))
      }
      onLogout={handleLogout}
      usersList={usersTabList}
      usersListLoading={usersTabLoading}
      selectedUserId={selectedUserId}
      onSelectUser={setSelectedUserId}
      middleContent={
        selectedUserId !== null ? (
          <div className={styles.usersTabStrip} role="tablist" aria-label="Vue utilisateur">
            <button
              type="button"
              role="tab"
              aria-selected
              className={`${styles.usersTabButton} ${styles.usersTabButtonActive}`}
            >
              Pointages
            </button>
          </div>
        ) : null
      }
    >
      <div className={styles.zoneLabel}>Pointages</div>
    </AppShell>
  )
}
