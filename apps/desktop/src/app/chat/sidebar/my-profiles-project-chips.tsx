import { useStore } from '@nanostores/react'
import { useMemo } from 'react'
import type * as React from 'react'

import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $connectionsRegistry } from '@/store/connection-registry-state'
import { normalizeProfileKey } from '@/store/profile'

import { myProfilesProjectNameKey, type SidebarProjectTree, type SidebarProjectOwnerRoute } from './projects/workspace-groups'

/**
 * Owner chips + duplicate-name mark for «Mis perfiles» project rows.
 *
 * Presentational by design: the scope gate, the name groups and the
 * ambiguous-profile set are computed once per overview render in `index.tsx`
 * and passed in, so a list of N projects costs one memo — not N store walks.
 * The only store read here is the connection registry, for gateway labels.
 *
 * - One chip per owning route (`profile`, or `profile · gateway` when the same
 *   profile name answers on more than one gateway — two gateways can carry
 *   homonymous profiles, and the pair is the identity).
 * - When the same normalized project name exists under more than one distinct
 *   route, a discreet duplicate mark precedes the chips; its tooltip lists
 *   every place the name lives.
 */
export interface MyProfilesProjectChipsProps {
  project: SidebarProjectTree
  projects: readonly SidebarProjectTree[]
}

const routeKey = (route: SidebarProjectOwnerRoute): string => `${route.connectionId}::${route.profile}`

export function MyProfilesProjectChips({ project, projects }: MyProfilesProjectChipsProps) {
  const { t } = useI18n()
  const registry = useStore($connectionsRegistry)
  const routes = project.myProfileOwnerRoutes ?? []
  const { siblings, ambiguousProfiles } = useMemo(() => {
    const groups = projects.filter(other => !other.isNoProject).filter(other =>
      myProfilesProjectNameKey(other.label) === myProfilesProjectNameKey(project.label)
    )
    const routesForName = groups.flatMap(other => other.myProfileOwnerRoutes ?? [])
    const profileConnections = new Map<string, Set<string>>()

    for (const route of routesForName) {
      const key = normalizeProfileKey(route.profile)
      const connections = profileConnections.get(key) ?? new Set<string>()
      connections.add(route.connectionId)
      profileConnections.set(key, connections)
    }

    return {
      siblings: groups.filter(other => other.id !== project.id),
      ambiguousProfiles: new Set([...profileConnections].filter(([, connections]) => connections.size > 1).map(([name]) => name))
    }
  }, [project, projects])

  if (!routes.length) {
    return null
  }

  const gatewayLabel = (connectionId: string): string =>
    registry?.connections.find(connection => connection.id === connectionId)?.label ?? connectionId

  const allRoutes = [...routes, ...siblings.flatMap(other => other.myProfileOwnerRoutes ?? [])]
  const isDuplicate = siblings.length > 0 && new Set(allRoutes.map(routeKey)).size > 1

  const locations = [...new Set(allRoutes.map(route => `${route.profile} · ${gatewayLabel(route.connectionId)}`))]

  return (
    <span className="flex shrink-0 items-center gap-1.5" data-owner-chips="">
      {isDuplicate && (
        <Tip label={t.sidebar.projects.duplicateProjectHint(project.label, locations.join(', '))}>
          <span
            aria-label={t.sidebar.projects.duplicateProjectHint(project.label, locations.join(', '))}
            className="grid place-items-center text-(--ui-text-tertiary)"
            data-duplicate-project="true"
            data-owner-chip=""
            role="img"
          >
            <Codicon name="copy" size="0.625rem" />
          </span>
        </Tip>
      )}
      {routes.map(route => {
        const ambiguous = ambiguousProfiles.has(normalizeProfileKey(route.profile))
        const text = ambiguous ? `${route.profile} · ${gatewayLabel(route.connectionId)}` : route.profile
        const label = t.sidebar.row.ownedByProfile(text)

        return (
          <Tip key={routeKey(route)} label={label}>
            <span
              aria-label={label}
              className={cn('max-w-24 truncate text-[0.625rem] leading-none', 'text-(--ui-text-tertiary)')}
              data-connection-id={route.connectionId}
              data-owner-chip=""
              data-profile={route.profile}
            >
              {text}
            </span>
          </Tip>
        )
      })}
    </span>
  )
}
