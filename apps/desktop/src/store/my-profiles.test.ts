import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listSidebarSessions } = vi.hoisted(() => ({ listSidebarSessions: vi.fn() }))
vi.mock('@/api/sessions', () => ({ listSidebarSessions }))

import { MY_PROFILES_SELECTION_STORAGE_KEY, $myProfilesSelection, invalidateMyProfilesRefresh, loadMyProfiles, mergeMyProfileSessions, myProfileRouteKey, namespaceMyProfileProjectTree, parseMyProfileRoute, setMyProfileSelected } from './my-profiles'

beforeEach(() => {
  window.localStorage.clear()
  $myProfilesSelection.set([])
  invalidateMyProfilesRefresh()
})

describe('my-profiles route identity', () => {
  it('persists selected (connection, profile) keys, not bare profile names', () => {
    setMyProfileSelected({ connectionId: 'gw-a', profile: 'default' }, true)
    setMyProfileSelected({ connectionId: 'gw-b', profile: 'default' }, true)
    expect($myProfilesSelection.get()).toEqual(['gw-a::default', 'gw-b::default'])
    expect(window.localStorage.getItem(MY_PROFILES_SELECTION_STORAGE_KEY)).toBe(JSON.stringify(['gw-a::default', 'gw-b::default']))
    expect(parseMyProfileRoute('gw-b::default')).toEqual({ connectionId: 'gw-b', profile: 'default' })
    expect(parseMyProfileRoute('default')).toBeNull()
  })

  it('namespaces duplicate project ids and stamps preview rows with their gateway owner', () => {
    const first = namespaceMyProfileProjectTree({ connectionId: 'gw-a', profile: 'default' }, {
      projects: [{ id: 'p_abc', label: 'A', previewSessions: [{ id: 's1', profile: 'default' } as never] }]
    })
    const second = namespaceMyProfileProjectTree({ connectionId: 'gw-b', profile: 'default' }, {
      projects: [{ id: 'p_abc', label: 'B', previewSessions: [{ id: 's2', profile: 'default' } as never] }]
    })
    expect(first.projects[0].id).toBe('gw-a::p_abc')
    expect(second.projects[0].id).toBe('gw-b::p_abc')
    expect(first.projects[0].sessions[0].connection_id).toBe('gw-a')
    expect(mergeMyProfileSessions([{ connectionId: 'gw-b', sessions: [{ id: 's2', profile: 'default' } as never] }])[0].connection_id).toBe('gw-b')
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

  it('removes an exact route without clearing another same-named profile', () => {
    setMyProfileSelected({ connectionId: 'gw-a', profile: 'default' }, true)
    setMyProfileSelected({ connectionId: 'gw-b', profile: 'default' }, true)
    setMyProfileSelected({ connectionId: 'gw-a', profile: 'default' }, false)
    expect($myProfilesSelection.get()).toEqual([myProfileRouteKey({ connectionId: 'gw-b', profile: 'default' })])
  })
})
