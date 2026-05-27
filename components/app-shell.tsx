'use client'

import type { ReactNode } from 'react'
import type { ActiveMenu, ShellNavigationOptions } from '../lib/app-ui-state'
import styles from './app-shell.module.css'

type AppShellProps = {
  connectedUsername: string
  userRole?: 'ADMIN' | 'EMPLOYE'
  activeTab: 'tab1' | 'tab2'
  activeMenu: ActiveMenu
  activeDemandesSubMenu: 'nouvelle' | 'voir' | null
  activeConfigurationSubMenu: 'taches' | null
  activeConfigurationTab: 'donnees' | 'historique'
  onTabChange: (tab: 'tab1' | 'tab2') => void
  onOpenAgenda: () => void
  onOpenPointage: () => void
  onOpenMenu: (menu: ActiveMenu, options?: ShellNavigationOptions) => void
  onConfigurationSubMenuChange: (value: 'taches' | null) => void
  onConfigurationTabChange: (value: 'donnees' | 'historique') => void
  onLogout: () => void
  middleContent?: ReactNode
  actionZoneCentered?: boolean
  usersList?: Array<{
    id: number
    firstName: string
    lastName: string
    statusCode?: string
    hasActiveSession?: boolean
  }>
  usersListLoading?: boolean
  selectedUserId?: number | null
  onSelectUser?: (userId: number) => void
  children: ReactNode
}

export function AppShell({
  connectedUsername,
  userRole = 'EMPLOYE',
  activeTab,
  activeMenu,
  activeDemandesSubMenu,
  activeConfigurationSubMenu,
  activeConfigurationTab,
  onTabChange,
  onOpenAgenda,
  onOpenPointage,
  onOpenMenu,
  onConfigurationSubMenuChange,
  onConfigurationTabChange,
  onLogout,
  middleContent,
  actionZoneCentered = false,
  usersList = [],
  usersListLoading = false,
  selectedUserId = null,
  onSelectUser,
  children,
}: AppShellProps) {
  const isAdmin = userRole === 'ADMIN'
  const resolvedActiveTab = isAdmin ? activeTab : 'tab1'
  const isSuiviActivitesActive = [
    'gestion_demandes',
    'gestion_taches',
  ].includes(activeMenu) && isAdmin

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
              <span className={styles.profileIcon}>
                <span className={styles.iconHead} />
                <span className={styles.iconBody} />
              </span>
            </div>
            <div className={styles.profileDropdown} role="menu" aria-label="Menu utilisateur">
              <button
                type="button"
                className={styles.profileDropdownItem}
                role="menuitem"
                onClick={onLogout}
              >
                Déconnexion
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className={styles.middleZone} aria-label="Zone intermédiaire">
        <div className={styles.tabStrip} role="tablist" aria-label="Choix onglets">
          <button
            type="button"
            role="tab"
            aria-selected={resolvedActiveTab === 'tab1'}
            className={`${styles.tabButton} ${resolvedActiveTab === 'tab1' ? styles.tabButtonActive : ''}`}
            onClick={() => onTabChange('tab1')}
          >
            Mon espace
          </button>
          {isAdmin ? (
            <button
              type="button"
              role="tab"
              aria-selected={resolvedActiveTab === 'tab2'}
              className={`${styles.tabButton} ${resolvedActiveTab === 'tab2' ? styles.tabButtonActive : ''}`}
              onClick={() => onTabChange('tab2')}
            >
              Utilisateurs
            </button>
          ) : null}
        </div>
        <div className={styles.middleContent}>{middleContent}</div>
      </div>

      <main className={styles.layout}>
        <aside className={styles.menuZone} aria-label="Zone menu">
          {resolvedActiveTab === 'tab1' ? (
            <nav className={styles.verticalMenu} aria-label="Menu principal">
              <button
                type="button"
                className={`${styles.menuItem} ${activeMenu === 'accueil' ? styles.menuItemActive : ''}`}
                onClick={onOpenAgenda}
              >
                Mon agenda
              </button>
              <button
                type="button"
                className={`${styles.menuItem} ${activeMenu === 'pointer' ? styles.menuItemActive : ''}`}
                onClick={onOpenPointage}
              >
                Mon pointage
              </button>
              <button
                type="button"
                className={`${styles.menuItem} ${activeMenu === 'taches' ? styles.menuItemActive : ''}`}
                onClick={() => onOpenMenu('taches')}
              >
                Mes tâches
              </button>
              {isAdmin ? (
                <>
                  <button
                    type="button"
                    className={`${styles.menuItem} ${activeMenu === 'demandes' ? styles.menuItemActive : ''}`}
                    onClick={() => onOpenMenu('demandes', { demandesSubMenu: null })}
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
                        onClick={() => onOpenMenu('demandes', { demandesSubMenu: 'nouvelle' })}
                      >
                        Nouvelle demande
                      </button>
                      <button
                        type="button"
                        className={`${styles.subMenuItem} ${
                          activeDemandesSubMenu === 'voir' ? styles.subMenuItemActive : ''
                        }`}
                        onClick={() => onOpenMenu('demandes', { demandesSubMenu: 'voir' })}
                      >
                        Consulter mes demandes
                      </button>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className={`${styles.menuItem} ${isSuiviActivitesActive ? styles.menuItemActive : ''}`}
                    onClick={() => onOpenMenu('gestion_taches')}
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
                        onClick={() => onOpenMenu('gestion_taches')}
                      >
                        Gestion des tâches
                      </button>
                      <button
                        type="button"
                        className={`${styles.subMenuItem} ${
                          activeMenu === 'gestion_demandes' ? styles.subMenuItemActive : ''
                        }`}
                        onClick={() => onOpenMenu('gestion_demandes')}
                      >
                        Gestion des demandes
                      </button>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className={`${styles.menuItem} ${
                      activeMenu === 'gestion_bdd' ? styles.menuItemActive : ''
                    }`}
                    onClick={() =>
                      onOpenMenu('gestion_bdd', {
                        configurationSubMenu: 'taches',
                        configurationTab: 'donnees',
                      })
                    }
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
                        onClick={() => onConfigurationSubMenuChange('taches')}
                      >
                        Tâches
                      </button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </nav>
          ) : (
            <div className={styles.usersPane} aria-label="Liste des utilisateurs">
              {usersListLoading ? (
                <p className={styles.usersHelperText}>Chargement des utilisateurs...</p>
              ) : usersList.length === 0 ? (
                <p className={styles.usersHelperText}>Aucun autre utilisateur à afficher.</p>
              ) : (
                <ul className={styles.usersList}>
                  {usersList.map((user) => (
                    <li key={user.id} className={styles.userItem}>
                      <button
                        type="button"
                        className={`${styles.userButton} ${
                          selectedUserId === user.id ? styles.userButtonActive : ''
                        }`}
                        onClick={() => onSelectUser?.(user.id)}
                      >
                        <span className={styles.userIcon} aria-hidden="true">
                          <span className={styles.userIconHead} />
                          <span className={styles.userIconBody} />
                        </span>
                        <span className={styles.userLabel}>
                          {`${user.firstName} ${user.lastName}`.trim()}
                        </span>
                        <span className={styles.userStatusWrap} aria-hidden="true">
                          {user.statusCode === 'EN_ATTENTE' ? (
                            <span
                              className={`${styles.userStatusBadge} ${styles.userStatusPending}`}
                              title="Compte en attente d'activation"
                            >
                              ⏳
                            </span>
                          ) : user.statusCode === 'DESACTIVE' ? (
                            <span
                              className={`${styles.userStatusBadge} ${styles.userStatusDisabled}`}
                              title="Compte désactivé"
                            >
                              ⛔
                            </span>
                          ) : (
                            <span
                              className={`${styles.userStatusDot} ${
                                user.hasActiveSession
                                  ? styles.userStatusDotOnline
                                  : styles.userStatusDotOffline
                              }`}
                              title={
                                user.hasActiveSession
                                  ? 'Pointage en cours'
                                  : 'Aucun pointage en cours'
                              }
                            />
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </aside>

        <section
          className={`${styles.actionZone} ${actionZoneCentered ? styles.actionZoneCentered : ''}`}
          aria-label="Zone actions"
        >
          {children}
        </section>
      </main>
    </div>
  )
}
