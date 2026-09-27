// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MyProfileRoute } from './my-profiles'
import {
  $myProfilesProjectTree,
  $myProfilesProjectTreeGatewayErrors,
  invalidateMyProfilesProjectTree,
  loadMyProfilesProjectTreeForRoutes,
  mergeMyProfilesProjectTrees,
  MY_PROFILES_HOME_KEY,
  type MyProfilesRouteProject,
  namespaceMyProfilesProjectTree,
  routeHomeId,
  setMyProfilesProjectTree,
  setMyProfilesProjectTreeGatewayErrors
} from './my-profiles-project-tree'

vi.mock('@/api/sessions', () => ({
  listSidebarSessionsProjectTree: vi.fn()
}))

const { listSidebarSessionsProjectTree } = await import('@/api/sessions')
const fetchTree = vi.mocked(listSidebarSessionsProjectTree)

const routeA: MyProfileRoute = { connectionId: 'gw-a', profile: 'default' }
const routeB: MyProfileRoute = { connectionId: 'gw-b', profile: 'default' }

const row = (id: string, connectionId: string) => ({
  ended_at: null,
  id,
  input_tokens: 0,
  is_active: false,
  last_active: 1_000,
  message_count: 1,
  model: null,
  output_tokens: 0,
  preview: null,
  source: 'cli',
  started_at: 1_000,
  title: id,
  tool_call_count: 0
})

const backendProject = (id: string, path: string, sessions: ReturnType<typeof row>[]): MyProfilesRouteProject => ({
  id,
  label: id,
  path,
  repos: [
    {
      id: path,
      label: id,
      path,
      sessionCount: sessions.length,
      groups: [
        {
          id: `${path}::main`,
          label: 'main',
          path,
          isMain: true,
          isKanban: false,
          sessions: []
        }
      ]
    }
  ],
  sessionCount: sessions.length,
  previewSessions: sessions,
  sessionIds: sessions.map(session => session.id)
})

const homeProject = (sessions: ReturnType<typeof row>[]): MyProfilesRouteProject => ({
  ...backendProject('__no_project__', '', sessions),
  path: null,
  isNoProject: true
})

beforeEach(() => {
  fetchTree.mockReset()
  setMyProfilesProjectTree([])
  setMyProfilesProjectTreeGatewayErrors([])
  invalidateMyProfilesProjectTree()
})

describe('recursive namespacing', () => {
  it('prefixes project, repo, lane and Home ids with the exact route and stamps every row', () => {
    const [project] = namespaceMyProfilesProjectTree(routeA, {
      projects: [backendProject('p_abc', '/repo/alpha', [row('s1', 'gw-a')])]
    })

    // Every level carries the owner prefix.
    expect(project.id).toBe('gw-a::p_abc')
    expect(project.repos[0].id).toBe('gw-a::/repo/alpha')
    expect(project.repos[0].groups[0].id).toBe('gw-a::/repo/alpha::main')
    // Preview rows carry the exact owner.
    expect(project.previewSessions?.[0]).toMatchObject({ id: 's1', connection_id: 'gw-a', profile: 'default' })
    // Session ids are namespaced with the connection: same stored id on two
    // hosts stays two claims.
    expect(project.sessionIds?.[0]).toBe('s1@gw-a')

    // Home is namespaced per route in the raw slice.
    const [home] = namespaceMyProfilesProjectTree(routeB, { projects: [homeProject([])] })
    expect(home.id).toBe(routeHomeId(routeB))
    expect(home.id).toBe('gw-b::__no_project__')
    expect(home.isNoProject).toBe(true)
  })
})

describe('merging two gateways with the SAME project id', () => {
  it('keeps both projects separate and folds Home into ONE cross-gateway group', () => {
    const treeA = namespaceMyProfilesProjectTree(routeA, {
      projects: [backendProject('p_abc', '/repo/alpha', [row('s1', 'gw-a')]), homeProject([row('h1', 'gw-a')])]
    })

    const treeB = namespaceMyProfilesProjectTree(routeB, {
      projects: [backendProject('p_abc', '/repo/beta', [row('s2', 'gw-b')]), homeProject([row('h2', 'gw-b')])]
    })

    const merged = mergeMyProfilesProjectTrees([treeA, treeB])
    const home = merged.filter(project => project.isNoProject)

    // p_abc twice (once per owner), Home once.
    expect(merged.filter(project => project.id.endsWith('::p_abc'))).toHaveLength(2)
    expect(home).toHaveLength(1)
    expect(home[0].id).toBe(MY_PROFILES_HOME_KEY)
    // The shared Home holds BOTH gateways' rows, each with its exact owner.
    expect(home[0].previewSessions?.map(session => session.connection_id).sort()).toEqual(['gw-a', 'gw-b'])
    expect(home[0].sessionCount).toBe(2)

    // Home leads the overview, like the single-backend tree.
    expect(merged[0].id).toBe(MY_PROFILES_HOME_KEY)
  })
})

describe('refresh lifecycle', () => {
  it('publishes merged results and keeps per-gateway failures explicit', async () => {
    fetchTree.mockImplementation(async route =>
      route.connectionId === 'gw-b'
        ? Promise.reject(new Error('offline'))
        : { projects: [backendProject('p_a', '/a', [])] }
    )

    const result = await loadMyProfilesProjectTreeForRoutes([routeA, routeB])

    expect(result).not.toBeNull()
    expect(result?.projects.map(project => project.id)).toEqual(['gw-a::p_a'])
    // B failed, A published: the degraded host is named, never silent.
    expect(result?.errors).toHaveLength(1)
    expect(result?.errors[0].connectionId).toBe('gw-b')
    expect($myProfilesProjectTreeGatewayErrors.get()).toEqual(result?.errors)
  })

  it('discards a superseded refresh so a late answer never paints a left scope', async () => {
    let resolveOld: (value: { projects: MyProfilesRouteProject[] }) => void = () => {}
    fetchTree.mockImplementation(route => {
      if (route.connectionId === 'gw-a') {
        return new Promise<{ projects: MyProfilesRouteProject[] }>(resolve => {
          resolveOld = resolve
        })
      }

      return Promise.resolve({ projects: [] as MyProfilesRouteProject[] })
    })

    const old = loadMyProfilesProjectTreeForRoutes([routeA])
    const newer = loadMyProfilesProjectTreeForRoutes([routeB])
    const newResult = await newer

    resolveOld({ projects: [backendProject('p_old', '/old', [])] })
    const oldResult = await old

    // The old refresh resolved AFTER being superseded: no publish.
    expect(oldResult).toBeNull()
    expect(newResult?.projects).toEqual([])
    expect($myProfilesProjectTree.get()).toEqual([])
  })

  it('publishes an empty tree and no errors when no route is selected', async () => {
    const result = await loadMyProfilesProjectTreeForRoutes([])

    expect(result).toBeNull()
    expect($myProfilesProjectTree.get()).toEqual([])
    expect($myProfilesProjectTreeGatewayErrors.get()).toEqual([])
  })
})
