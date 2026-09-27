import { atom } from 'nanostores'

import { listSidebarSessions } from '@/api/sessions'
import { hermesApi } from '@/api/client'
import { readJson, writeJson } from '@/lib/storage'
import type { SessionInfo } from '@/types/hermes'

export const MY_PROFILES = '__my_profiles__'
export const MY_PROFILES_SELECTION_STORAGE_KEY = 'hermes.desktop.myProfilesSelection'

export interface MyProfileRoute {
  connectionId: string
  profile: string
}

export const myProfileRouteKey = ({ connectionId, profile }: MyProfileRoute): string => `${connectionId}::${profile}`

export function parseMyProfileRoute(key: string): MyProfileRoute | null {
  const separator = key.indexOf('::')
  if (separator < 1 || separator + 2 >= key.length) return null
  return { connectionId: key.slice(0, separator), profile: key.slice(separator + 2) }
}

function loadSelection(): string[] {
  const value = readJson<unknown>(MY_PROFILES_SELECTION_STORAGE_KEY)
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((item): item is string => typeof item === 'string' && parseMyProfileRoute(item) !== null)
        )
      ]
    : []
}

export const $myProfilesSelection = atom<string[]>(loadSelection())
$myProfilesSelection.subscribe(value => writeJson(MY_PROFILES_SELECTION_STORAGE_KEY, value))

export function setMyProfileSelected(route: MyProfileRoute, selected: boolean): void {
  const key = myProfileRouteKey(route)
  const current = $myProfilesSelection.get()
  const next = selected ? [...new Set([...current, key])] : current.filter(item => item !== key)
  $myProfilesSelection.set(next)
}

export function selectedMyProfileRoutes(selection = $myProfilesSelection.get()): MyProfileRoute[] {
  return selection.flatMap(key => {
    const route = parseMyProfileRoute(key)
    return route ? [route] : []
  })
}

export interface MyProfilesGatewayResult {
  connectionId: string
  sessions: SessionInfo[]
  error?: string
}

export interface MyProfilesProjectTree {
  connectionId: string
  profile: string
  projects: Array<{ id: string; label: string; path: string | null; sessions: SessionInfo[] }>
  error?: string
}

let refreshGeneration = 0
export const $myProfilesGatewayErrors = atom<Array<{ connectionId: string; profile: string; message: string }>>([])

/** Read all pages per selected gateway/profile explicitly, never filtering a partial page. */
export async function loadMyProfiles(
  options: {
    routes?: MyProfileRoute[]
    limit?: number
  } = {}
): Promise<MyProfilesGatewayResult[]> {
  const generation = ++refreshGeneration
  const routes = options.routes ?? selectedMyProfileRoutes()
  const initialLimit = Math.max(1, options.limit ?? 100)
  const results = await Promise.all(
    routes.map(async route => {
      try {
        let limit = initialLimit
        let rows: SessionInfo[] = []
        while (true) {
          const result = await listSidebarSessions({
            connectionId: route.connectionId,
            recentsProfile: route.profile,
            recentsLimit: limit,
            recentsExclude: ['cron', 'kanban', 'oneshot', 'subagent', 'tool', 'telegram', 'discord', 'slack', 'email'],
            cronLimit: 1,
            messagingLimit: 1,
            messagingExclude: ['cron']
          } as Parameters<typeof listSidebarSessions>[0] & { connectionId: string })
          rows = result.recents.sessions
          if (rows.length < limit || limit >= 2000) break
          limit = Math.min(limit * 2, 2000)
        }
        return {
          connectionId: route.connectionId,
          sessions: rows
            .filter(session => (session.profile || 'default') === route.profile)
            .map(session => ({ ...session, connection_id: route.connectionId, profile: route.profile }))
        }
      } catch (error) {
        return {
          connectionId: route.connectionId,
          sessions: [],
          error: error instanceof Error ? error.message : String(error)
        }
      }
    })
  )
  if (generation === refreshGeneration) {
    $myProfilesGatewayErrors.set(
      results.flatMap(result =>
        result.error
          ? [
              {
                connectionId: result.connectionId,
                profile: routes.find(route => route.connectionId === result.connectionId)?.profile ?? 'default',
                message: result.error
              }
            ]
          : []
      )
    )
    return results
  }
  return []
}

export function invalidateMyProfilesRefresh(): void {
  refreshGeneration++
}

/** Namespace projects by exact route to prevent same-name/id collisions across gateways. */
export function namespaceMyProfileProjectTree(
  route: MyProfileRoute,
  tree: { projects?: Array<{ id: string; label: string; path?: string | null; previewSessions?: SessionInfo[] }> }
): MyProfilesProjectTree {
  return {
    connectionId: route.connectionId,
    profile: route.profile,
    projects: (tree.projects ?? []).map(project => ({
      id: `${route.connectionId}::${project.id}`,
      label: project.label,
      path: project.path ?? null,
      sessions: (project.previewSessions ?? []).map(session => ({
        ...session,
        connection_id: route.connectionId,
        profile: route.profile
      }))
    }))
  }
}

/** Fetch project tree on the selected registered gateway; caller owns degraded-state presentation. */
export async function loadMyProfileProjectTree(route: MyProfileRoute): Promise<MyProfilesProjectTree> {
  try {
    const tree = await hermesApi<{
      projects?: Array<{ id: string; label: string; path?: string | null; previewSessions?: SessionInfo[] }>
    }>({
      connectionId: route.connectionId,
      profile: route.profile,
      path: '/api/profiles/projects/tree?preview_limit=2000',
      timeoutMs: 60_000
    })
    return namespaceMyProfileProjectTree(route, tree)
  } catch (error) {
    return {
      connectionId: route.connectionId,
      profile: route.profile,
      projects: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Merge source slices while retaining exact (connection, profile) identity. */
export function mergeMyProfileSessions(results: MyProfilesGatewayResult[]): SessionInfo[] {
  return results.flatMap(result => result.sessions.map(session => ({ ...session, connection_id: result.connectionId })))
}

/** Contract helper exposed to actions: never dispatch a write with a profile-only owner. */
export function myProfileSessionRoute(session: Pick<SessionInfo, 'connection_id' | 'profile'>): MyProfileRoute | null {
  const connectionId = session.connection_id?.trim()
  const profile = session.profile?.trim()
  return connectionId && profile ? { connectionId, profile } : null
}
