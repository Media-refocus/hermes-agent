import { describe, expect, it } from 'vitest'

import { ALL_PROFILES } from '@/store/profile'
import type { SessionInfo } from '@/types/hermes'

import { filterSessionsByProfileScope } from './profile-scope'

/** Build the smallest session row needed by the profile-scope tests. */
const row = (id: string, profile?: string): SessionInfo =>
  ({ id, message_count: 1, profile, source: 'signal', started_at: 0, title: id }) as SessionInfo

describe('filterSessionsByProfileScope', () => {
  it('keeps only rows from the selected profile', () => {
    const rows = [row('default-row', 'default'), row('work-row', 'work')]

    expect(filterSessionsByProfileScope(rows, 'work').map(session => session.id)).toEqual(['work-row'])
  })

  it('treats legacy rows without a profile as default', () => {
    const rows = [row('legacy-row'), row('work-row', 'work')]

    expect(filterSessionsByProfileScope(rows, 'default').map(session => session.id)).toEqual(['legacy-row'])
  })

  it('preserves every row in the canonical all-profiles scope', () => {
    const rows = [row('default-row', 'default'), row('work-row', 'work')]

    expect(filterSessionsByProfileScope(rows, ALL_PROFILES)).toBe(rows)
  })

  it('does not empty ALL scope when every row is one profile', () => {
    const rows = [row('a', 'default'), row('b', 'default'), row('c', 'default')]
    expect(filterSessionsByProfileScope(rows, ALL_PROFILES)).toBe(rows)
  })

  it('leaves route-filtering to selected pairs in My profiles scope', () => {
    const rows = [row('a', 'default'), row('b', 'default')]
    expect(filterSessionsByProfileScope(rows, '__my_profiles__')).toBe(rows)
  })
})
