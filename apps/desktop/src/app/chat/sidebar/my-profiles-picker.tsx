import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { $fleetRoster, refreshFleetRoster } from '@/store/fleet-roster'
import { $myProfilesSelection, setMyProfileSelected } from '@/store/my-profiles'

export function MyProfilesPicker({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n()
  const roster = useStore($fleetRoster)
  const selected = useStore($myProfilesSelection)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    setLoading(true)
    void refreshFleetRoster({ force: true }).finally(() => setLoading(false))
  }, [open])
  const groups = useMemo(() => (roster?.sources ?? []).map(source => ({
    ...source,
    agents: (roster?.agents ?? []).filter(agent => agent.connectionId === source.connectionId)
  })), [roster])

  return <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t.profiles.myProfiles}</DialogTitle></DialogHeader>
      <div className="max-h-[60vh] space-y-4 overflow-y-auto">
        {groups.map(group => <section key={group.connectionId} aria-label={group.label}>
          <h3 className="mb-2 text-sm font-medium">{group.label}</h3>
          {!group.reachable && <p role="status" className="mb-2 text-sm text-amber-600">{t.profiles.gatewayOffline(group.label)}</p>}
          {group.agents.map(agent => {
            const key = `${agent.connectionId}::${agent.profile}`
            return <label className="flex items-center gap-2 py-1" key={key}>
              <Checkbox checked={selected.includes(key)} onCheckedChange={checked => setMyProfileSelected({ connectionId: agent.connectionId, profile: agent.profile }, checked === true)} />
              <span>{agent.profile}</span>
            </label>
          })}
        </section>)}
        {!groups.length && <p>{loading ? t.profiles.loadingProfiles : t.profiles.noProfilesFound}</p>}
      </div>
      <Button onClick={() => onOpenChange(false)}>{t.common.done}</Button>
    </DialogContent>
  </Dialog>
}
