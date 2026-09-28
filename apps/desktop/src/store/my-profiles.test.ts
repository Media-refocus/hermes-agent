import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listRouteSessionsPage, listSidebarSessions } = vi.hoisted(() => ({
  listRouteSessionsPage: vi.fn(),
  listSidebarSessions: vi.fn()
}))
vi.mock('@/api/sessions', () => ({ listRouteSessionsPage, listSidebarSessions }))

import {
  MY_PROFILES_SELECTION_STORAGE_KEY,
  $myProfilesIncomplete,
  $myProfilesSelection,
  invalidateMyProfilesRefresh,
  loadMyProfiles,
  mergeMyProfileSessions,
  myProfileRouteKey,
  namespaceMyProfileProjectTree,
  parseMyProfileRoute,
  setMyProfileSelected
} from './my-profiles'

beforeEach(() => {
  listSidebarSessions.mockReset()
  listRouteSessionsPage.mockReset()
  window.localStorage.clear()
  $myProfilesSelection.set([])
  invalidateMyProfilesRefresh()
})

describe('my-profiles route identity', () => {
  it('persists selected (connection, profile) keys, not bare profile names', () => {
    setMyProfileSelected({ connectionId: 'gw-a', profile: 'default' }, true)
    setMyProfileSelected({ connectionId: 'gw-b', profile: 'default' }, true)
    expect($myProfilesSelection.get()).toEqual(['gw-a::default', 'gw-b::default'])
    expect(window.localStorage.getItem(MY_PROFILES_SELECTION_STORAGE_KEY)).toBe(
      JSON.stringify(['gw-a::default', 'gw-b::default'])
    )
    expect(parseMyProfileRoute('gw-b::default')).toEqual({ connectionId: 'gw-b', profile: 'default' })
    expect(parseMyProfileRoute('default')).toBeNull()
  })

  it('namespaces duplicate project ids and stamps preview rows with their gateway owner', () => {
    const first = namespaceMyProfileProjectTree(
      { connectionId: 'gw-a', profile: 'default' },
      {
        projects: [{ id: 'p_abc', label: 'A', previewSessions: [{ id: 's1', profile: 'default' } as never] }]
      }
    )
    const second = namespaceMyProfileProjectTree(
      { connectionId: 'gw-b', profile: 'default' },
      {
        projects: [{ id: 'p_abc', label: 'B', previewSessions: [{ id: 's2', profile: 'default' } as never] }]
      }
    )
    expect(first.projects[0].id).toBe('gw-a::p_abc')
    expect(second.projects[0].id).toBe('gw-b::p_abc')
    expect(first.projects[0].sessions[0].connection_id).toBe('gw-a')
    expect(
      mergeMyProfileSessions([{ connectionId: 'gw-b', sessions: [{ id: 's2', profile: 'default' } as never] }])[0]
        .connection_id
    ).toBe('gw-b')
  })

  it('keeps offline gateways explicit and discards a superseded refresh', async () => {
    const request = listSidebarSessions.mockRejectedValue(new Error('offline'))
    const old = loadMyProfiles({ routes: [{ connectionId: 'gw-a', profile: 'default' }] })
    const newer = loadMyProfiles({ routes: [{ connectionId: 'gw-b', profile: 'default' }] })
    const [oldResult, newResult] = await Promise.all([old, newer])
    expect(oldResult).toEqual([])
    expect(newResult).toEqual([{ connectionId: 'gw-b', sessions: [], error: 'offline' }])
    expect(request.mock.calls.map(([arg]) => arg.connectionId)).toEqual(['gw-a', 'gw-b'])
  })

  it('continues past a full window through the per-profile pinned walk, keeping only the route profile', async () => {
    // The batched window came back full AND mixed (defensive: the concrete
    // recents_profile scope means the server filters, but the walk must not
    // depend on it). Continuation pages come from the per-profile endpoint —
    // whose ?profile= pin makes another profile's rows unreachable — so the
    // selected homonymous profile is not cut off and never rides an unpinned call.
    listSidebarSessions.mockResolvedValue({
      recents: {
        sessions: [
          { id: 'a', profile: 'default' },
          { id: 'other', profile: 'worker' }
        ],
        profiles_truncated: { default: true }
      },
      cron: { sessions: [] },
      messaging: { sessions: [] }
    })
    listRouteSessionsPage.mockResolvedValue({
      sessions: [{ id: 'b', profile: 'default' }],
      total: 2,
      limit: 100,
      offset: 0
    })
    const [result] = await loadMyProfiles({ routes: [{ connectionId: 'gw-a', profile: 'default' }], limit: 2 })
    expect(listSidebarSessions).toHaveBeenCalledTimes(1)
    expect(listRouteSessionsPage.mock.calls[0][0]).toEqual({ connectionId: 'gw-a', profile: 'default' })
    expect(result.sessions.map(session => session.id)).toEqual(['a', 'b'])
    expect(result.sessions.every(session => session.connection_id === 'gw-a')).toBe(true)
  })

  it('removes an exact route without clearing another same-named profile', () => {
    setMyProfileSelected({ connectionId: 'gw-a', profile: 'default' }, true)
    setMyProfileSelected({ connectionId: 'gw-b', profile: 'default' }, true)
    setMyProfileSelected({ connectionId: 'gw-a', profile: 'default' }, false)
    expect($myProfilesSelection.get()).toEqual([myProfileRouteKey({ connectionId: 'gw-b', profile: 'default' })])
  })
})

describe('my-profiles recents pagination', () => {
  const sidebarPage = (ids: string[], profile = 'default', truncated = false) => ({
    recents: {
      sessions: ids.map(id => ({ id, profile })),
      ...(truncated ? { profiles_truncated: { [profile]: true } } : {})
    },
    cron: { sessions: [] },
    messaging: { sessions: [] }
  })

  // The server-side window is hard-capped at 500; request 650 to prove the
  // walk PAST the cap instead of stopping where the old `rows.length < limit`
  // check silently dropped everything beyond the first full page.
  const TOTAL = 650

  it('pages past the sidebar cap until the backend count is exhausted, then stamps owners', async () => {
    const atCap = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, profile: 'default' }))
    listSidebarSessions.mockResolvedValue(sidebarPage(atCap.map(row => row.id), 'default', true))

    // Two offset pages (100 + 50), then the count stops the walk — mirrors
    // GET /api/sessions?profile=&limit=100&offset=… returning short/total-bounded pages.
    listRouteSessionsPage.mockImplementation(async (_route: unknown, { offset }: { offset: number }) => {
      const size = offset + 100 >= TOTAL ? TOTAL - offset : 100
      return {
        sessions: Array.from({ length: size }, (_, i) => ({ id: `s${offset + i}`, profile: 'default' })),
        total: TOTAL,
        limit: 100,
        offset
      }
    })

    const [result] = await loadMyProfiles({ routes: [{ connectionId: 'gw-a', profile: 'default' }], limit: 650 })

    // The batched read rode the route pin; the walk continued past 500.
    expect(listSidebarSessions.mock.calls[0][0].connectionId).toBe('gw-a')
    expect(listRouteSessionsPage).toHaveBeenCalledTimes(2)
    expect(listRouteSessionsPage.mock.calls.map(([, opts]) => opts.offset)).toEqual([500, 600])
    expect(result.sessions).toHaveLength(TOTAL)
    expect(result.sessions[0].id).toBe('s0')
    expect(result.sessions.at(-1)).toMatchObject({ id: 's649', connection_id: 'gw-a', profile: 'default' })
    expect(result.sessions.every(session => session.connection_id === 'gw-a')).toBe(true)
    // Fully loaded: no incomplete warning for this route.
    expect(result.incomplete).toBeUndefined()
    expect($myProfilesIncomplete.get()).toEqual([])
  })

  it('does not repeat rows across offset pages when pins ride every page', async () => {
    const atCap = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, profile: 'default' }))
    listSidebarSessions.mockResolvedValue(sidebarPage(atCap.map(row => row.id), 'default', true))

    // The pinned back-fill re-lists pins outside the LIMIT window, so every
    // page repeats the pinned row — the walk must dedupe on lineage identity.
    listRouteSessionsPage.mockImplementation(async (_route: unknown, { offset }: { offset: number }) => {
      const size = offset + 100 >= 600 ? 600 - offset : 100
      return {
        sessions: [
          { id: 'pinned', profile: 'default', _lineage_root_id: 'pinned' },
          ...Array.from({ length: size }, (_, i) => ({ id: `s${offset + i}`, profile: 'default' }))
        ],
        total: 600,
        limit: 100,
        offset
      }
    })

    const [result] = await loadMyProfiles({ routes: [{ connectionId: 'gw-a', profile: 'default' }], limit: 650 })

    expect(result.sessions.filter(session => session.id === 'pinned')).toHaveLength(1)
    // 500 (window) + 100 (page) unique rows; the repeat was absorbed.
    expect(result.sessions).toHaveLength(601)
  })

  it('warns «lista incompleta» when the profile exceeds the hard bound, isolated per route', async () => {
    const atCap = Array.from({ length: 500 }, (_, i) => ({ id: `a${i}`, profile: 'default' }))
    listSidebarSessions.mockImplementation(async request =>
      sidebarPage(
        (request.connectionId === 'gw-a' ? atCap.map(row => row.id) : ['b0', 'b1']),
        'default',
        request.connectionId === 'gw-a'
      )
    )
    // gw-a keeps answering full pages — more than MAX_ROUTES exists on disk.
    listRouteSessionsPage.mockImplementation(async (_route: unknown, { offset }: { offset: number }) => ({
      sessions: Array.from({ length: 100 }, (_, i) => ({ id: `a${offset + i}`, profile: 'default' })),
      total: 100_000,
      limit: 100,
      offset
    }))

    const results = await loadMyProfiles({
      routes: [
        { connectionId: 'gw-a', profile: 'default' },
        { connectionId: 'gw-b', profile: 'default' }
      ],
      limit: 650
    })

    const [a, b] = results
    // A hit the ceiling with rows still on disk: honest warning, capped list.
    expect(a.incomplete).toBe(true)
    expect(a.sessions.length).toBeLessThanOrEqual(2000)
    // B loaded completely — one route's bound must not flag the other, and a
    // same-named profile on another gateway never rides A's pages.
    expect(b.incomplete).toBeUndefined()
    expect(b.sessions.map(session => session.id)).toEqual(['b0', 'b1'])
    expect(listRouteSessionsPage.mock.calls.every(([route]) => route.connectionId === 'gw-a')).toBe(true)
    expect($myProfilesIncomplete.get()).toEqual([{ connectionId: 'gw-a', profile: 'default' }])
  })

  it('clears the incomplete warning when the next refresh loads fully', async () => {
    const atCap = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, profile: 'default' }))
    listSidebarSessions.mockResolvedValue(sidebarPage(atCap.map(row => row.id), 'default', true))
    listRouteSessionsPage.mockImplementation(async (_route: unknown, { offset }: { offset: number }) => ({
      sessions: Array.from({ length: 100 }, (_, i) => ({ id: `s${offset + i}`, profile: 'default' })),
      total: 100_000,
      limit: 100,
      offset
    }))

    await loadMyProfiles({ routes: [{ connectionId: 'gw-a', profile: 'default' }], limit: 650 })
    expect($myProfilesIncomplete.get()).toHaveLength(1)

    // Now the backend has fewer rows than the bound (the archived them all).
    listSidebarSessions.mockResolvedValue(sidebarPage(['only-one'], 'default', false))
    listRouteSessionsPage.mockClear()
    await loadMyProfiles({ routes: [{ connectionId: 'gw-a', profile: 'default' }], limit: 650 })
    expect(listRouteSessionsPage).not.toHaveBeenCalled()
    expect($myProfilesIncomplete.get()).toEqual([])
  })
})
