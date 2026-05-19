export const UI_STATE_STORAGE_KEY = 'app_pointer_accueil_ui_state'
export const CONNECTED_USERNAME_STORAGE_KEY = 'app_pointer_connected_username'
export const UI_STATE_CHANGED_EVENT = 'app_pointer_ui_state_changed'
export const CONNECTED_USERNAME_CHANGED_EVENT = 'app_pointer_connected_username_changed'

export type ActiveMenu =
  | 'accueil'
  | 'pointer'
  | 'taches'
  | 'demandes'
  | 'suivi_activites'
  | 'gestion_demandes'
  | 'gestion_taches'
  | 'gestion_pointages'
  | 'gestion_bdd'

export type PersistedUiState = {
  activeTab: 'tab1' | 'tab2'
  activeMenu: ActiveMenu
  activeAgendaTab: 'semaine' | 'mois'
  activeDemandesSubMenu: 'nouvelle' | 'voir' | null
  activePointagesSubMenu: 'nouveau' | null
  activeConfigurationSubMenu: 'taches' | null
  activeConfigurationTab: 'donnees' | 'historique'
}

export type ShellNavigationOptions = {
  demandesSubMenu?: 'nouvelle' | 'voir' | null
  pointagesSubMenu?: 'nouveau' | null
  configurationSubMenu?: 'taches' | null
  configurationTab?: 'donnees' | 'historique'
}

export const DEFAULT_UI_STATE: PersistedUiState = {
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

export function readStoredUiState() {
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

export function subscribeToUiStateStorage(onStoreChange: () => void) {
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

export function readStoredUsername() {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.localStorage.getItem(CONNECTED_USERNAME_STORAGE_KEY) ?? ''
}

export function subscribeToUsernameStorage(onStoreChange: () => void) {
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

export function updatePersistedUiState(
  updater: (previousState: PersistedUiState) => PersistedUiState
) {
  if (typeof window === 'undefined') {
    return
  }

  const nextState = updater(readStoredUiState())
  window.localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(nextState))
  window.dispatchEvent(new Event(UI_STATE_CHANGED_EVENT))
}
