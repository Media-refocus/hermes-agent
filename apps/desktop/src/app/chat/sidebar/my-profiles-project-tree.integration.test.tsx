// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarProvider } from '@/components/ui/sidebar'
import { $connectionsRegistry } from '@/store/connection-registry-state'
import { $sidebarRowMeta, setSidebarAgentsGrouped } from '@/store/layout'
import {
  invalidateMyProfilesProjectTree,
  mergeMyProfilesProjectTrees,
  MY_PROFILES_HOME_KEY,
  namespaceMyProfilesProjectTree,
  setMyProfilesProjectTree,
  setMyProfilesProjectTreeGatewayErrors
} from '@/store/my-profiles-project-tree'
import { $activeGatewayProfile, $profiles, setShowMyProfiles } from '@/store/profile'
import { $projectScope, ALL_PROJECTS } from '@/store/project-scope'
import { $sessions } from '@/store/session'
import { makeSessionInfo } from '@/test/session-info'

import { ChatSidebar } from './index'

const noop = () => {}

const noopAsync = async () => {}

const resume = vi.fn()

const mount = (): ReturnType<typeof render> & { container: HTMLElement } =>
  render(
    <MemoryRouter>
      <SidebarProvider>
        <ChatSidebar
          currentView="chat"
          onArchiveSession={noop}
          onBranchSession={noop}
          onDeleteSession={noop}
          onLoadMoreSessions={noop}
          onManageCronJob={noop}
          onNavigate={noop}
          onNewSessionInWorkspace={noop}
          onNewSessionSplit={noop}
          onResumeSession={resume}
          onRetrySessions={noopAsync}
          onTriggerCronJob={noopAsync}
        />
      </SidebarProvider>
    </MemoryRouter>
  )

// The overview payload shape `projects.tree` returns for one profile: project ->
// repos -> lanes, with `previewSessions` carrying the visible rows.
const backendTree = (
  id: string,
  path: string | null,
  sessions: ReturnType<typeof makeSessionInfo>[],
  flags: { isNoProject?: boolean; isAuto?: boolean } = {}
) => ({
  id,
  label: id,
  path,
  color: null,
  icon: null,
  isAuto: flags.isAuto ?? false,
  isNoProject: flags.isNoProject ?? false,
  repos: path
    ? [
        {
          id: path,
          label: id,
          path,
          sessionCount: sessions.length,
          groups: [{ id: `${path}::main`, label: 'main', path, isMain: true, isKanban: false, sessions: [] }]
        }
      ]
    : [
        {
          id: '__no_project__',
          label: 'Home',
          path: null,
          sessionCount: sessions.length,
          groups: [{ id: '__no_project__', label: 'Home', path: null, isMain: false, isKanban: false, sessions: [] }]
        }
      ],
  sessionCount: sessions.length,
  totalTokens: 0,
  totalCostUsd: 0,
  lastActive: sessions.reduce((latest, session) => Math.max(latest, session.last_active || 0), 0),
  previewSessions: sessions,
  sessionIds: sessions.map(session => session.id)
})

const routeA = { connectionId: 'gw-a', profile: 'default' }
const routeB = { connectionId: 'gw-b', profile: 'default' }

beforeEach(() => {
  act(() => {
    $connectionsRegistry.set({
      version: 2,
      primary: 'local',
      secureTokenStorage: true,
      connections: [
        { id: 'gw-a', label: 'This computer', kind: 'local', tokenSet: false, tokenPreview: null },
        { id: 'gw-b', label: 'Homelab', kind: 'remote', tokenSet: false, tokenPreview: null }
      ]
    })
    $profiles.set([
      { name: 'default', is_default: true },
      { name: 'work', is_default: false }
    ] as typeof $profiles.value)
    $activeGatewayProfile.set('default')
    $projectScope.set(ALL_PROJECTS)
    $sessions.set([])
    $sidebarRowMeta.set([])
    setSidebarAgentsGrouped(true)
    setShowMyProfiles(true)
  })
})

afterEach(() => {
  cleanup()
  act(() => {
    setShowMyProfiles(false)
    setSidebarAgentsGrouped(false)
    setMyProfilesProjectTree([])
    setMyProfilesProjectTreeGatewayErrors([])
    invalidateMyProfilesProjectTree()
    $projectScope.set(ALL_PROJECTS)
    $sessions.set([])
    $activeGatewayProfile.set('')
  })
  resume.mockReset()
})

describe('my-profiles merged project overview (two gateways)', () => {
  it('separates the same project id per gateway, folds Home into one group, and routes the B row to B', () => {
    const sessionA = makeSessionInfo({
      id: 's1',
      profile: 'default',
      connection_id: 'gw-a',
      cwd: '/repo/alpha',
      title: 'Alpha on A',
      last_active: 2_000
    })

    const sessionB = makeSessionInfo({
      id: 's2',
      profile: 'default',
      connection_id: 'gw-b',
      cwd: '/repo/beta',
      title: 'Beta on B',
      last_active: 3_000
    })

    const homeB = makeSessionInfo({
      id: 's3',
      profile: 'work',
      connection_id: 'gw-b',
      title: 'Detached on B',
      last_active: 2_500
    })

    act(() => {
      // The store's refresh merges the route slices; do the same here so the
      // overview sees exactly what a live refresh publishes.
      setMyProfilesProjectTree(
        mergeMyProfilesProjectTrees([
          namespaceMyProfilesProjectTree(routeA, { projects: [backendTree('p_abc', '/repo/alpha', [sessionA])] }),
          namespaceMyProfilesProjectTree(routeB, {
            projects: [
              backendTree('p_abc', '/repo/beta', [sessionB]),
              backendTree('__no_project__', null, [homeB], { isNoProject: true })
            ]
          })
        ])
      )
      $sessions.set([sessionA, sessionB, homeB])
    })

    const { container } = mount()

    const overview = container.querySelector('[data-sessions-mode="projects"]')
    expect(overview).toBeTruthy()

    const projectIds = [...container.querySelectorAll('[data-sessions-project]')].map(row =>
      row.getAttribute('data-sessions-project')
    )

    // The same backend project id on both gateways stays TWO rows.
    expect(projectIds.filter(id => id === 'gw-a::p_abc')).toHaveLength(1)
    expect(projectIds.filter(id => id === 'gw-b::p_abc')).toHaveLength(1)

    // Previews keep their owner: each row shows its own session, never the twin's.
    expect(screen.getByText('Alpha on A')).toBeTruthy()
    expect(screen.getByText('Beta on B')).toBeTruthy()

    // One Home group across gateways; the detached B row lives there.
    const homeRows = projectIds.filter(id => id === MY_PROFILES_HOME_KEY)
    expect(homeRows).toHaveLength(1)
    expect(screen.getByText('Detached on B')).toBeTruthy()

    // Session click carries the OWNING gateway (B), not the ambient one (A).
    fireEvent.click(screen.getByText('Beta on B'))
    expect(resume).toHaveBeenLastCalledWith('s2', expect.objectContaining({ connection_id: 'gw-b', profile: 'default' }))
  })

  it('keeps gateway A projects visible and announces gateway B offline', () => {
    const sessionA = makeSessionInfo({
      id: 's1',
      profile: 'default',
      connection_id: 'gw-a',
      cwd: '/repo/alpha',
      title: 'Alpha on A',
      last_active: 2_000
    })

    act(() => {
      setMyProfilesProjectTree(
        namespaceMyProfilesProjectTree(routeA, { projects: [backendTree('p_abc', '/repo/alpha', [sessionA])] })
      )
      setMyProfilesProjectTreeGatewayErrors([{ connectionId: 'gw-b', message: 'ssh: connection refused' }])
      $sessions.set([sessionA])
    })

    mount()

    expect(screen.getByText('Alpha on A')).toBeTruthy()
    const statuses = screen.getAllByRole('status')
    expect(statuses.some(status => status.textContent?.includes('Homelab'))).toBe(true)
  })

  it('never attributes a live session to a project whose owner route the tree does not name', () => {
    // One stored session id on two gateways; the tree only knows the B twin.
    const twinB = makeSessionInfo({
      id: 's1',
      profile: 'default',
      connection_id: 'gw-b',
      cwd: '/repo/alpha',
      title: 'Alpha twin on B',
      last_active: 2_000
    })

    const staleA = makeSessionInfo({
      id: 's1',
      profile: 'default',
      connection_id: 'gw-a',
      cwd: '/repo/alpha',
      title: 'Alpha on A',
      last_active: 1_500
    })

    act(() => {
      setMyProfilesProjectTree(
        namespaceMyProfilesProjectTree(routeB, { projects: [backendTree('p_abc', '/repo/alpha', [twinB])] })
      )
      $sessions.set([twinB, staleA])
    })

    mount()

    expect(screen.getByText('Alpha twin on B')).toBeTruthy()
    expect(screen.queryByText('Alpha on A')).toBeNull()
  })
})
