import { atom } from 'nanostores'

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/workspace-groups'
import { NO_PROJECT_ID } from '@/app/chat/sidebar/projects/workspace-groups'
import type { SessionInfo } from '@/types/hermes'

import { $myProfilesSelection, type MyProfileRoute } from './my-profiles'

// ── «Mis perfiles» project tree (multi-gateway) ──────────────────────────────
// `projects.tree` answers for ONE profile of ONE backend, so every selected
// (connectionId, profile) route fetches its own tree and the results merge for
// the sidebar's project overview. Namespacing happens at EVERY level — project,
// repo, lane, Home — with the exact route (`connectionId::id`), so the same
// project id on two gateways stays two separate rows and same-named session ids
// cannot collide. Every session row carries its owner (connection_id + profile)
// so clicks and mutations route to the gateway that owns the chat.

/** The overview fetch asks for the whole preview window (matches the fan-out cap). */
export const MY_PROFILES_PROJECT_TREE_PREVIEW_LIMIT = 2000

export const $myProfilesProjectTree = atom<SidebarProjectTree[]>([])
export const $myProfilesProjectTreeGatewayErrors = atom<Array<{ connectionId: string; message: string }>>([])

/** The backend's synthetic Home bucket id (`NO_PROJECT_ID`). */
const NO_PROJECT = '__no_project__'
/** Home inside ONE route's namespaced slice. */
export const routeHomeId = (route: MyProfileRoute): string => `${route.connectionId}::${NO_PROJECT}`

/**
 * Shared Home id across routes — the backend's own `NO_PROJECT_ID`. Home means
 * "no project claimed this chat" — the same synthetic bucket on every backend —
 * so one group renders instead of one per gateway, and the row-level filter
 * rule (`sessionBucketId` files detached rows under `NO_PROJECT_ID`) matches
 * it. Ownership stays exact: every session under the merged Home keeps its own
 * connection_id + profile.
 */
export const MY_PROFILES_HOME_KEY = NO_PROJECT_ID

export interface MyProfilesRouteProject {
  id: string
  label: string
  path?: string | null
  color?: null | string
  icon?: null | string
  archived?: boolean
  isAuto?: boolean
  isNoProject?: boolean
  repos?: Array<{
    id: string
    label: string
    path?: string | null
    sessionCount?: number
    // repo-level
    groups?: Array<{
      id: string
      label: string
      path?: string | null
      isMain?: boolean
      isKanban?: boolean
      isGit?: boolean
      mode?: 'profile' | 'source' | 'workspace'
      sourceId?: string
      sessions?: SessionInfo[]
    }>
  }>
  sessionCount?: number
  totalTokens?: number
  totalCostUsd?: number
  lastActive?: number
  previewSessions?: SessionInfo[]
  sessionIds?: string[]
}

interface MyProfilesTreePayload {
  projects?: MyProfilesRouteProject[]
}

/** Stamp a session row with its exact owner. The FETCH route is authoritative —
 *  the backend knows nothing of Desktop registry ids. */
const stampSessionOwner = (route: MyProfileRoute, session: SessionInfo): SessionInfo => ({
  ...session,
  connection_id: route.connectionId,
  profile: route.profile
})

const namespacedId = (route: MyProfileRoute, id: string): string => `${route.connectionId}::${id}`

/**
 * Namespace one route's `projects.tree` payload RECURSIVELY: project ids, repo
 * ids, lane ids and Home all get the `connectionId::` prefix; every session row
 * (preview AND hydrated lane) is stamped with the exact owner route.
 */
export function namespaceMyProfilesProjectTree(
  route: MyProfileRoute,
  payload: MyProfilesTreePayload
): SidebarProjectTree[] {
  const projects: SidebarProjectTree[] = []

  for (const project of payload.projects ?? []) {
    const home = Boolean(project.isNoProject) || project.id === NO_PROJECT

    projects.push({
      ...project,
      id: home ? routeHomeId(route) : namespacedId(route, project.id),
      path: project.path ?? null,
      sessionCount: project.sessionCount ?? 0,
      repos: (project.repos ?? []).map(repo => ({
        ...repo,
        id: namespacedId(route, repo.id),
        path: repo.path ?? null,
        sessionCount: repo.sessionCount ?? 0,
        groups: (repo.groups ?? []).map(group => ({
          ...group,
          id: namespacedId(route, group.id),
          path: group.path ?? null,
          sessions: (group.sessions ?? []).map(session => stampSessionOwner(route, session))
        }))
      })),
      previewSessions: (project.previewSessions ?? []).map(session => stampSessionOwner(route, session)),
      // Session ids are only unique PER BACKEND, so the owner map namespaces
      // them with the connection too (`s1@gw-a` ≠ `s1@gw-b`).
      sessionIds: (project.sessionIds ?? []).map(id => `${id}@${route.connectionId}`)
    })
  }

  return projects
}

/**
 * The live-overlay owner map for this scope, keyed by (possibly namespaced)
 * session id: the tree is authoritative for which project claimed a session.
 * A live row (its id a backend id without prefix) resolves through its
 * `sessionIds` entry + connection stamp, so a twin on the other gateway never
 * claims it.
 */
export const myProfilesProjectOwnerBySessionId = (
  projects: readonly SidebarProjectTree[],
  sessions: readonly SessionInfo[]
): ReadonlyMap<string, string> => {
  // Backend-id → project id, per owning connection: `s1` + gw-a → `gw-a::p_abc`.
  const byConnection = new Map<string, Map<string, string>>()

  for (const project of projects) {
    const route = projectOwnerRoute(project.id)

    if (!route) {
      continue
    }

    let perConnection = byConnection.get(route.connectionId)

    if (!perConnection) {
      perConnection = new Map()
      byConnection.set(route.connectionId, perConnection)
    }

    const ids = [
      ...(project.sessionIds ?? []),
      ...(project.previewSessions ?? []).map(session => session.id),
      ...project.repos.flatMap(repo => repo.groups.flatMap(group => group.sessions.map(session => session.id)))
    ]

    for (const id of ids) {
      // Undo the per-connection namespacing of `sessionIds`.
      perConnection.set(id.includes('@') ? id.slice(0, id.lastIndexOf('@')) : id, project.id)
    }
  }

  const owners = new Map<string, string>()

  for (const session of sessions) {
    const connectionId = (session.connection_id ?? '').trim()

    if (!connectionId) {
      continue
    }

    const projectId = byConnection.get(connectionId)?.get(session.id)

    if (projectId) {
      owners.set(session.id, projectId)
    }
  }

  return owners
}

/** The owner route encoded in a namespaced project id, or null for Home. */
export function projectOwnerRoute(id: string): MyProfileRoute | null {
  const separator = id.indexOf('::')

  if (separator < 1 || separator + 2 >= id.length) {return null}

  return { connectionId: id.slice(0, separator), profile: id.slice(separator + 2) }
}

/** Fold namespaced route trees into ONE overview list. Same project id on two
 *  gateways stays two rows; the routes' Home rows fold into one bucket (Home is
 *  "no project", not a host's project) that leads the list.
 *
 *  The merged Home keeps the backend's `NO_PROJECT_ID`, NOT a merged-specific
 *  key: the one row-level filter rule (`sessionMatchesProjectFilter`) files
 *  detached rows under `NO_PROJECT_ID` via `sessionBucketId`, so a Home under
 *  any other id filters to nothing — selecting Home emptied the sidebar. The
 *  merged node is still recognisable by its `isNoProject` flag (and leads the
 *  list, as the single-backend tree's Home does). */
export function mergeMyProfilesProjectTrees(routeTrees: SidebarProjectTree[][]): SidebarProjectTree[] {
  const ordered: SidebarProjectTree[] = []
  const seen = new Set<string>()
  const homes: SidebarProjectTree[] = []

  for (const tree of routeTrees) {
    for (const project of tree) {
      if (project.isNoProject) {
        const current = homes[0]

        if (!current) {
          homes[0] = { ...project, id: NO_PROJECT_ID }
        } else {
          homes[0] = {
            ...current,
            sessionCount: (current.sessionCount ?? 0) + (project.sessionCount ?? 0),
            lastActive: Math.max(current.lastActive ?? 0, project.lastActive ?? 0),
            totalTokens: (current.totalTokens ?? 0) + (project.totalTokens ?? 0),
            totalCostUsd: (current.totalCostUsd ?? 0) + (project.totalCostUsd ?? 0),
            previewSessions: [...(current.previewSessions ?? []), ...(project.previewSessions ?? [])].sort(
              (a, b) => (b.last_active || 0) - (a.last_active || 0)
            ),
            sessionIds: [...(current.sessionIds ?? []), ...(project.sessionIds ?? [])]
          }
        }

        continue
      }

      if (!seen.has(project.id)) {
        seen.add(project.id)
        ordered.push(project)
      }
    }
  }

  return homes.length ? [homes[0], ...ordered] : ordered
}

let myProfilesProjectTreeGeneration = 0

/** Invalidate every in-flight and published tree (scope left / new refresh). */
export function invalidateMyProfilesProjectTree(): void {
  myProfilesProjectTreeGeneration++
}

/** Replace the merged tree directly (tests; the sidebar only reads it). */
export function setMyProfilesProjectTree(tree: SidebarProjectTree[]): void {
  $myProfilesProjectTree.set(tree)
}

export function setMyProfilesProjectTreeGatewayErrors(
  errors: Array<{ connectionId: string; message: string }>
): void {
  $myProfilesProjectTreeGatewayErrors.set(errors)
}

const REQUEST_TIMEOUT_MS = 60_000

/** The raw wire payload for one route's project tree (namespacing happens in
 *  `namespaceMyProfilesProjectTree`; `errors[]` is inspected by the loader). */
async function listTreePayload(route: MyProfileRoute): Promise<Record<string, unknown>> {
  const { listSidebarSessionsProjectTree } = await import('@/api/sessions')

  const payload = await listSidebarSessionsProjectTree(route, {
    previewLimit: MY_PROFILES_PROJECT_TREE_PREVIEW_LIMIT,
    timeoutMs: REQUEST_TIMEOUT_MS
  })

  return (payload ?? {}) as unknown as Record<string, unknown>
}

export async function loadMyProfilesProjectTreeForRoutes(
  routes: readonly MyProfileRoute[],
  fetchRouteTree: (route: MyProfileRoute) => Promise<Record<string, unknown>> = listTreePayload
): Promise<{ projects: SidebarProjectTree[]; errors: Array<{ connectionId: string; message: string }> } | null> {
  const generation = ++myProfilesProjectTreeGeneration

  if (!routes.length) {
    if (generation === myProfilesProjectTreeGeneration) {
      $myProfilesProjectTree.set([])
      $myProfilesProjectTreeGatewayErrors.set([])
    }

    return null
  }

  const settled = await Promise.all(
    routes.map(async route => {
      try {
        const payload = await fetchRouteTree(route)

        // Per-profile read failures the backend could still answer for the
        // OTHER profiles on this gateway (`errors[]`, e.g. a locked or corrupt
        // state.db): a successful HTTP response can still be a degraded one.
        // The sidebar's banner keys on connectionId, so any profile-level
        // error degrades that gateway visibly — never silently.
        const payloadErrors = (payload as { errors?: Array<{ profile?: string; error?: string }> }).errors ?? []
        const payloadMessage = payloadErrors
          .map(entry => `${entry.profile || 'profile'}: ${entry.error || 'read failed'}`)
          .join('; ')

        return {
          route,
          tree: namespaceMyProfilesProjectTree(route, payload as MyProfilesTreePayload),
          error: payloadMessage || null
        }
      } catch (error) {
        return {
          route,
          tree: [] as SidebarProjectTree[],
          error: error instanceof Error ? error.message : String(error)
        }
      }
    })
  )

  // A newer refresh (selection change / scope exit) owns the tree: drop this one.
  if (generation !== myProfilesProjectTreeGeneration) {
    return null
  }

  const errors = settled.flatMap(entry =>
    entry.error ? [{ connectionId: entry.route.connectionId, message: entry.error }] : []
  )

  const projects = mergeMyProfilesProjectTrees(settled.map(entry => entry.tree))

  $myProfilesProjectTree.set(projects)
  $myProfilesProjectTreeGatewayErrors.set(errors)

  return { projects, errors }
}

/** Fetch every selected route's tree concurrently and merge for the overview. */
export async function loadMyProfilesProjectTree(): Promise<
  { projects: SidebarProjectTree[]; errors: Array<{ connectionId: string; message: string }> } | null
> {
  const routes = $myProfilesSelection.get().flatMap(key => {
    const separator = key.indexOf('::')

    return separator > 0 ? [{ connectionId: key.slice(0, separator), profile: key.slice(separator + 2) }] : []
  })

  return loadMyProfilesProjectTreeForRoutes(routes)
}
