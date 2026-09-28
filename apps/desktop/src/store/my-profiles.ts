import { atom } from 'nanostores'

import { listRouteSessionsPage, listSidebarSessions } from '@/api/sessions'
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
  /** The route's list is INCOMPLETE and stayed incomplete after paging: either
   *  the backend still reported more rows past the MAX_ROUTES bound, or a page
   *  failed mid-walk. Rendered as its own honest warning — never folded into
   *  the gateway-offline banner, which this result did not earn. */
  incomplete?: boolean
}

export interface MyProfilesProjectTree {
  connectionId: string
  profile: string
  projects: Array<{ id: string; label: string; path: string | null; sessions: SessionInfo[] }>
  error?: string
}

let refreshGeneration = 0
export const $myProfilesGatewayErrors = atom<Array<{ connectionId: string; profile: string; message: string }>>([])
export const $myProfilesIncomplete = atom<Array<{ connectionId: string; profile: string }>>([])

/** Sessions recents the sidebar's own window excludes (mirrors the recents
 *  taxonomy; cron gets its own section, messaging its own slice). */
export const MY_PROFILES_RECENTS_EXCLUDE = [
  'cron',
  'kanban',
  'oneshot',
  'subagent',
  'tool',
  'telegram',
  'discord',
  'slack',
  'email'
]

// `/api/profiles/sessions/sidebar` answers recents with a HARD 500-row cap per
// profile (profiles.py: cap = min(recents_limit, 500)), and the server is not
// ours to change. Rows past 500 came back as `profiles_truncated` with the page
// 500/500 full — which `rows.length < limit` read as DONE, silently dropping
// every conversation past the cap. The ladder below keeps the one-request
// batched read as rung one, then pages the per-profile endpoint (LIMIT≤100
// per request, the server's own guard) with the EXPLICIT offset it was built
// for, until the page comes back short or the bound is hit.
const SIDEBAR_RECENTS_CAP = 500
const PAGE_SIZE = 100
/** Absolute ceiling per route: a hard bound, not a completion promise. A
 *  profile with more rows than this gets everything up to it plus the honest
 *  «lista incompleta» warning — never an unbounded request storm. */
const MAX_ROUTES = 2000

/** Dedupe pages on the durable lineage identity, so the pinned back-fill
 *  (which re-lists pins outside the LIMIT window) cannot render a conversation
 *  twice when its rows span a page boundary. */
function appendDeduped(rows: SessionInfo[], seen: Set<string>, page: SessionInfo[]): void {
  for (const session of page) {
    const identity = session._lineage_root_id || session.id

    if (seen.has(identity)) {
      continue
    }

    seen.add(identity)
    rows.push(session)
  }
}

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
  const results: MyProfilesGatewayResult[] = await Promise.all(
    routes.map(async route => {
      try {
        const first = await listSidebarSessions({
          connectionId: route.connectionId,
          recentsProfile: route.profile,
          recentsLimit: initialLimit,
          recentsExclude: MY_PROFILES_RECENTS_EXCLUDE,
          cronLimit: 1,
          messagingLimit: 1,
          messagingExclude: ['cron']
        } as Parameters<typeof listSidebarSessions>[0] & { connectionId: string })

        // Rows keep their recency order across the whole walk. Owner fields
        // (connection_id, profile) are stamped AFTER the merge so a row that
        // arrives twice cannot flip its identity mid-page.
        const seen = new Set<string>()
        const rows: SessionInfo[] = []
        appendDeduped(rows, seen, first.recents.sessions)

        // Truncated says the window came back full and more rows exist on
        // disk. An absent flag (legacy backend / legacy per-slice fallback)
        // falls back to the same signal the pre-fix client had: a full page.
        const requested = Math.min(Math.max(initialLimit, 1), SIDEBAR_RECENTS_CAP)
        const truncated = first.recents.profiles_truncated?.[route.profile] ?? rows.length >= requested
        let incomplete = truncated
        let offset = rows.length

        if (truncated) {
          while (rows.length < MAX_ROUTES) {
            const page = await listRouteSessionsPage(route, {
              limit: PAGE_SIZE,
              offset,
              excludeSources: MY_PROFILES_RECENTS_EXCLUDE
            })

            appendDeduped(rows, seen, page.sessions)
            offset += page.sessions.length

            // A short page is the end of the list. page.sessions can exceed
            // the page itself (pinned back-fill), so `total` — the server's
            // own count under the same filters — is the authoritative stop.
            if (page.sessions.length < PAGE_SIZE || (page.total ?? 0) <= offset) {
              incomplete = false
              break
            }
          }
        }

        return {
          connectionId: route.connectionId,
          sessions: rows
            .filter(session => (session.profile || 'default') === route.profile)
            .map(session => ({ ...session, connection_id: route.connectionId, profile: route.profile })),
          ...(incomplete ? { incomplete: true } : {})
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
    $myProfilesIncomplete.set(
      results.flatMap(result =>
        result.incomplete
          ? [
              {
                connectionId: result.connectionId,
                profile: routes.find(route => route.connectionId === result.connectionId)?.profile ?? 'default'
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
  $myProfilesIncomplete.set([])
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
