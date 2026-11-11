import { Button } from '../../ds'
import { backLabel, backToProjects, useLeaving } from './nav'

// The way out of a scene from a full-screen card (loading, code error).
export function BackButton(): JSX.Element {
  const leaving = useLeaving()
  return (
    <Button variant="ghost" size="lg" onClick={backToProjects} disabled={leaving} aria-busy={leaving}>
      {leaving ? 'Saving…' : backLabel()}
    </Button>
  )
}
