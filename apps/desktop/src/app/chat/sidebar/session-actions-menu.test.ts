import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $activeSessionId, $selectedStoredSessionId, setSessions } from '@/store/session'

import { makeSessionInfo } from '@/test/session-info'

import { renameSessionPreferringRpc } from './session-actions-menu'

// The branched-session rename bug: a freshly branched session lives only in the
// gateway's runtime _sessions map (no state.db row yet), so REST PATCH
// /api/sessions/{id} 404s with "Session not found". renameSessionPreferringRpc
// must route the ACTIVE row through the session.title RPC (runtime id), which
// persists the row on demand, and otherwise fall back to REST.

// Hoisted so the vi.mock factories below (which vitest lifts to the top of the
// module) can reference these before the module body runs. This matters because
// projects.ts subscribes to $gateway at import and nanostores fires the
// subscriber synchronously — that reaches the @/store/gateway mock's
// activeGateway() during the transitive import on line 4, before a plain
// module-level const would be initialized (temporal dead zone).
const { renameSession, request, activeGateway, routedRequest } = vi.hoisted(() => ({
  renameSession: vi.fn(async () => ({ ok: true, title: 'rest-title' })),
  request: vi.fn(async (..._args: unknown[]) => ({ title: 'rpc-title' }) as never),
  activeGateway: vi.fn<() => { request: unknown } | null>(() => ({ request: undefined })),
  routedRequest: vi.fn(async (..._args: unknown[]) => ({ title: 'routed-title' }) as never)
}))

// Wire activeGateway's default return to the shared request mock now that it exists.
activeGateway.mockReturnValue({ request })

vi.mock('@/hermes', () => ({
  renameSession: (...args: unknown[]) => renameSession(...(args as [])),
  // profile.ts calls this at import (its $activeGatewayProfile subscribe fires
  // immediately), pulled in transitively via session-states.
  setApiRequestProfile: () => {},
  HermesGateway: class {}
}))

vi.mock('@/store/gateway', () => ({
  // projects.ts subscribes to $gateway at module load (its repo-scan sync fires
  // immediately), pulled in transitively via the session store. Provide a real
  // atom plus the hoisted activeGateway so the synchronous subscriber doesn't
  // throw on an incomplete mock or hit an uninitialized reference.
  $gateway: atom(null),
  activeGateway: () => activeGateway(),
  // The session request router's routed seam: what a connection-tagged owner
  // (e.g. a «Mis perfiles» row on gw-b) must be dispatched through.
  requestGatewayForAgent: routedRequest,
  requestGatewayForProfile: routedRequest
}))

vi.mock('@/store/session-request-router', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  requestForSessionProfile: (
    owner: unknown,
    _ambient: unknown,
    method: string,
    params?: Record<string, unknown>
  ) =>
    typeof owner === 'object' && owner !== null && 'connectionId' in owner
      ? routedRequest(
          (owner as { connectionId: string }).connectionId,
          (owner as { connectionId: string; profile: string }).profile,
          method,
          params
        )
      : request(method, params)
}))

const RUNTIME_ID = 'rt-runtime-1'
const STORED_ID = 'stored-branch-1'

afterEach(() => {
  renameSession.mockClear()
  request.mockClear()
  routedRequest.mockClear()
  activeGateway.mockReset()
  activeGateway.mockReturnValue({ request })
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  setSessions([])
})

describe('renameSessionPreferringRpc', () => {
  it('renames the active branched session via the session.title RPC, not REST', async () => {
    $selectedStoredSessionId.set(STORED_ID)
    $activeSessionId.set(RUNTIME_ID)

    const result = await renameSessionPreferringRpc(STORED_ID, 'My branch')

    expect(request).toHaveBeenCalledWith('session.title', { session_id: RUNTIME_ID, title: 'My branch' })
    expect(renameSession).not.toHaveBeenCalled()
    expect(result.title).toBe('rpc-title')
  })

  it('falls back to REST when the RPC fails (e.g. socket mid-reconnect)', async () => {
    $selectedStoredSessionId.set(STORED_ID)
    $activeSessionId.set(RUNTIME_ID)
    request.mockRejectedValueOnce(new Error('not connected'))

    const result = await renameSessionPreferringRpc(STORED_ID, 'My branch', 'work')

    // The first (profile-only) attempt fails, and the rename still lands via
    // REST with the same owner.
    expect(renameSession).toHaveBeenCalledOnce()
    expect(renameSession).toHaveBeenCalledWith(STORED_ID, 'My branch', 'work')
    expect(result.title).toBe('rest-title')
  })

  it('routes the RPC through the session router for a legacy profile-only owner (ambient socket)', async () => {
    $selectedStoredSessionId.set(STORED_ID)
    $activeSessionId.set(RUNTIME_ID)

    const result = await renameSessionPreferringRpc(STORED_ID, 'My branch', 'work')

    expect(request).toHaveBeenCalledWith('session.title', { session_id: RUNTIME_ID, title: 'My branch' })
    expect(renameSession).not.toHaveBeenCalled()
    expect(result.title).toBe('rpc-title')
  })

  it('uses REST for a non-active row (background/persisted session)', async () => {
    $selectedStoredSessionId.set('some-other-active-session')
    $activeSessionId.set(RUNTIME_ID)

    await renameSessionPreferringRpc(STORED_ID, 'My branch', 'work')

    expect(request).not.toHaveBeenCalled()
    expect(renameSession).toHaveBeenCalledWith(STORED_ID, 'My branch', 'work')
  })

  it('uses REST when clearing the title (RPC rejects empty titles)', async () => {
    $selectedStoredSessionId.set(STORED_ID)
    $activeSessionId.set(RUNTIME_ID)

    await renameSessionPreferringRpc(STORED_ID, '')

    expect(request).not.toHaveBeenCalled()
    expect(renameSession).toHaveBeenCalledWith(STORED_ID, '', undefined)
  })

  it('uses REST when no gateway is connected', async () => {
    $selectedStoredSessionId.set(STORED_ID)
    $activeSessionId.set(RUNTIME_ID)
    activeGateway.mockReturnValue(null)

    await renameSessionPreferringRpc(STORED_ID, 'My branch')

    expect(request).not.toHaveBeenCalled()
    expect(renameSession).toHaveBeenCalledWith(STORED_ID, 'My branch', undefined)
  })

  it('routes a connection-tagged active row to ITS gateway, not whichever is ambient', async () => {
    // «Mis perfiles»: the session lives on gw-b while the window's ambient
    // socket is gw-a. The RPC must reach gw-b — the routed owner — and the
    // ambient gateway mock must never see the request.
    setSessions([makeSessionInfo({ connection_id: 'gw-b', id: STORED_ID, profile: 'default' })])
    $selectedStoredSessionId.set(STORED_ID)
    $activeSessionId.set(RUNTIME_ID)

    const result = await renameSessionPreferringRpc(STORED_ID, 'My branch')

    expect(routedRequest).toHaveBeenCalledWith('gw-b', 'default', 'session.title', {
      session_id: RUNTIME_ID,
      title: 'My branch'
    })
    expect(request).not.toHaveBeenCalled()
    expect(renameSession).not.toHaveBeenCalled()
    expect(result.title).toBe('routed-title')
  })
})
