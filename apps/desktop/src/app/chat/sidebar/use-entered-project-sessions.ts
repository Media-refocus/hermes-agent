import { replaceEqualDeep } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { requestGatewayForAgent } from '@/store/gateway'
import { projectOwnerRoute } from '@/store/my-profiles-project-tree'
import { $profileScope, MY_PROFILES_SCOPE } from '@/store/profile'
import { fetchProjectSessions } from '@/store/projects'
import type { SessionInfo } from '@/types/hermes'

import type { SidebarProjectTree } from './projects/workspace-groups'

// The mounted drill-in owns its outcome. A global error flag lets a departed
// project's slow failure overwrite the next project's successful load.
export function useEnteredProjectSessions(
  projectId: string | undefined,
  ready: boolean,
  treeRevision: readonly SidebarProjectTree[],
  scope: string
) {
  const [project, setProject] = useState<SidebarProjectTree | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [retryToken, setRetryToken] = useState(0)

  // Refetch when the entered project's own overview node changes, not on every
  // tree refresh: each `projects.project_sessions` call hydrates the whole tree
  // on the backend, which takes seconds over a remote gateway (#77591). The
  // tree keeps unchanged nodes by reference, so this is stable across no-ops.
  const enteredNode = projectId ? treeRevision.find(node => node.id === projectId) : undefined

  useEffect(() => {
    setProject(null)
  }, [projectId, scope])

  useEffect(() => {
    let cancelled = false
    setFailed(false)

    if (!projectId || !ready) {
      setProject(null)
      setLoading(false)

      return
    }

    setLoading(true)
    void fetchEnteredProjectSessions(projectId)
      .then(next => {
        if (!cancelled) {
          // An unchanged answer keeps its reference, so the lanes don't rebuild.
          setProject(current => replaceEqualDeep(current, next))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [projectId, ready, enteredNode, scope, retryToken])

  // A background refetch keeps painting the rows it has; only a drill-in with
  // nothing loaded yet reports loading (the sidebar shows skeletons for it).
  return { project, failed, loading: loading && !project, retry: () => setRetryToken(token => token + 1) }
}

/**
 * Hydrated lanes for ONE entered project, routed to the backend that owns it.
 *
 * In «Mis perfiles» a namespaced id (`gw-b::p_abc`) names its owner route
 * explicitly: the read goes to THAT gateway with THAT profile and the answer's
 * session rows keep the exact owner — never the ambient backend. Any other
 * scope keeps the single-backend path (`projects.project_sessions` on the live
 * gateway).
 */
async function fetchEnteredProjectSessions(projectId: string): Promise<SidebarProjectTree | null> {
  if ($profileScope.get() !== MY_PROFILES_SCOPE) {
    return fetchProjectSessions(projectId)
  }

  const owner = projectOwnerRoute(projectId)

  if (!owner) {
    // Home (or a malformed id): no single backend to ask — the overview's
    // merged previews are the source, so there is nothing to hydrate.
    return null
  }

  const res = await requestGatewayForAgent<{ project: SidebarProjectTree | null }>(
    owner.connectionId,
    owner.profile,
    'projects.project_sessions',
    // The raw project id belongs to the owner's own backend; strip the
    // `connectionId::` namespacing before asking it.
    { profile: owner.profile, project_id: projectId.slice(projectId.indexOf('::') + 2) },
    60_000,
    undefined,
    { spawnPriority: 'background' }
  )

  const project = res.project ?? null

  if (!project) {
    return null
  }

  // Restamp the hydrated rows with the exact owner: the backend cannot tag
  // Desktop registry ids, and the preview rows the user just saw carried them.
  const stamp = (session: SessionInfo): SessionInfo => ({
    ...session,
    connection_id: owner.connectionId,
    profile: owner.profile
  })

  return {
    ...project,
    id: projectId,
    repos: project.repos.map(repo => ({
      ...repo,
      groups: repo.groups.map(group => ({
        ...group,
        sessions: (group.sessions ?? []).map(stamp)
      }))
    })),
    previewSessions: (project.previewSessions ?? []).map(stamp)
  }
}
