import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// «Mis perfiles» send routing, at the REAL session-request layer.
//
// The window's one session-scoped RPC dispatcher (createSessionRpcDispatcher —
// the same closure every prompt.submit in the app goes through) must carry a
// send to the gateway that OWNS the selected session. No routing decision is
// mocked here: the production owner ladder runs (runtime event scope → tile →
// hint → connection-tagged row → REST probe), and only the transport seams
// (requestGatewayForAgent / requestGatewayForProfile / ambient socket) are
// stubs the assertions read.
//
// The scenario from the audit: gw-a and gw-b both expose a profile named
// `default`, gw-a is the AMBIENT/active connection, and the user sends into a
// session whose row (and runtime events) name gw-b. A bare-profile route would
// collapse onto gw-a's socket and 4001 "session not found" — or worse, fork
// the turn onto the wrong machine.

const gatewayMocks = vi.hoisted(() => ({
  activeConnectionId: 'gw-a' as null | string,
  requestGatewayForAgent: vi.fn(async () => ({ routed: true })),
  requestGatewayForProfile: vi.fn(async () => ({ profiled: true }))
}))

vi.mock('@/store/gateway', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  activeGatewayConnectionId: () => gatewayMocks.activeConnectionId,
  requestGatewayForAgent: gatewayMocks.requestGatewayForAgent,
  requestGatewayForProfile: gatewayMocks.requestGatewayForProfile
}))

const probe = vi.hoisted(() => ({ resolveSessionOwner: vi.fn(async () => undefined as unknown) }))

vi.mock('@/app/session/hooks/use-session-actions/utils', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  resolveSessionOwner: probe.resolveSessionOwner
}))

const { createSessionRpcDispatcher } = await import('./session-rpc-dispatcher')
const { $connectionsRegistry } = await import('@/store/connection-registry-state')
const { $profiles } = await import('@/store/profile')

const {
  _resetSessionOwnerHintsForTests,
  setMessagingSessions,
  setSessionOwnerHint,
  setSessions
} = await import('@/store/session')

const { $sessionTiles, recordSessionEventScope } = await import('@/store/session-states')
const { isSessionOwnerResolutionError } = await import('@/store/session-owner-resolution')
const { makeSessionInfo } = await import('@/test/session-info')

function dispatcher(selectedStoredSessionId: null | string = null) {
  const ambientRequest = vi.fn(async () => ({ ambient: true }))

  return {
    ambientRequest,
    request: createSessionRpcDispatcher({
      ambientRequest: ambientRequest as never,
      runtimeIdByStoredSessionIdRef: { current: new Map([['stored-b', 'rt-b']]) },
      selectedStoredSessionIdRef: { current: selectedStoredSessionId },
      sessionStateByRuntimeIdRef: { current: new Map() }
    })
  }
}

beforeEach(() => {
  gatewayMocks.activeConnectionId = 'gw-a'
  gatewayMocks.requestGatewayForAgent.mockClear()
  gatewayMocks.requestGatewayForProfile.mockClear()
  $connectionsRegistry.set({ connections: [{ id: 'gw-a' }, { id: 'gw-b' }] } as never)
  $profiles.set([{ name: 'default' }] as never)
  probe.resolveSessionOwner.mockResolvedValue(undefined)
})

afterEach(() => {
  $connectionsRegistry.set(null)
  $profiles.set([])
  setSessions([])
  setMessagingSessions([])
  $sessionTiles.set([])
  _resetSessionOwnerHintsForTests({ storage: true })
  vi.clearAllMocks()
})

describe('send to a selected session on gateway B under «Mis perfiles»', () => {
  it('routes prompt.submit to gw-b with the owning profile while gw-a is ambient (runtime-event owner)', async () => {
    // The inbound runtime event proved which socket owns the session — the
    // strongest rung, and the one that carries the connection a bare profile
    // name loses.
    recordSessionEventScope({ connectionId: 'gw-b', profile: 'default', session_id: 'rt-b' })
    // The sidebar row agrees (it came from the per-route fan-out, stamped).
    setSessions([makeSessionInfo({ connection_id: 'gw-a', id: 'stored-a', profile: 'default' })])

    const { ambientRequest, request } = dispatcher('stored-b')

    await expect(request('prompt.submit', { session_id: 'rt-b', text: 'hola desde B' })).resolves.toEqual({
      routed: true
    })

    expect(gatewayMocks.requestGatewayForAgent).toHaveBeenCalledWith('gw-b', 'default', 'prompt.submit', {
      session_id: 'rt-b',
      text: 'hola desde B'
    })
    // Ambient is presentation, never the route — and a same-named profile on
    // the primary must not leak the send onto gw-a's socket.
    expect(ambientRequest).not.toHaveBeenCalled()
    expect(gatewayMocks.requestGatewayForProfile).not.toHaveBeenCalled()
  })

  it('keeps routing on the row when the runtime binding is cold (connection-tagged row)', async () => {
    setSessions([makeSessionInfo({ connection_id: 'gw-b', id: 'stored-b', profile: 'default' })])

    const { ambientRequest, request } = dispatcher('stored-b')

    await expect(request('prompt.submit', { session_id: 'rt-b', text: 'again' })).resolves.toEqual({ routed: true })

    expect(gatewayMocks.requestGatewayForAgent).toHaveBeenCalledWith('gw-b', 'default', 'prompt.submit', {
      session_id: 'rt-b',
      text: 'again'
    })
    expect(ambientRequest).not.toHaveBeenCalled()
  })

  it('same contract for a background (non-selected) messaging row on gw-b', async () => {
    setMessagingSessions([makeSessionInfo({ connection_id: 'gw-b', id: 'stored-b', profile: 'default', source: 'photon' })])

    const { ambientRequest, request } = dispatcher('stored-a')

    await expect(request('prompt.submit', { session_id: 'rt-b', text: 'queue drain' })).resolves.toEqual({
      routed: true
    })

    expect(gatewayMocks.requestGatewayForAgent).toHaveBeenLastCalledWith('gw-b', 'default', 'prompt.submit', {
      session_id: 'rt-b',
      text: 'queue drain'
    })
    expect(ambientRequest).not.toHaveBeenCalled()
  })

  it('routes by the persisted hint after a relaunch when neither event nor row carries the connection', async () => {
    setSessions([makeSessionInfo({ id: 'stored-b', profile: 'default' })])
    setSessionOwnerHint('stored-b', { connectionId: 'gw-b', profile: 'default', targetProfile: 'default' })

    const { request } = dispatcher()

    await expect(request('prompt.submit', { session_id: 'rt-b', text: 'post-restart' })).resolves.toEqual({
      routed: true
    })

    expect(gatewayMocks.requestGatewayForAgent).toHaveBeenCalledWith('gw-b', 'default', 'prompt.submit', {
      session_id: 'rt-b',
      text: 'post-restart'
    })
  })

  it('fails closed rather than sending to the wrong gateway when the owner cannot be named', async () => {
    setSessions([])
    const { ambientRequest, request } = dispatcher()

    await expect(request('prompt.submit', { session_id: 'rt-orphan', text: 'hi' })).rejects.toSatisfy(
      isSessionOwnerResolutionError
    )
    expect(gatewayMocks.requestGatewayForAgent).not.toHaveBeenCalled()
    expect(gatewayMocks.requestGatewayForProfile).not.toHaveBeenCalled()
    expect(ambientRequest).not.toHaveBeenCalled()
  })
})
