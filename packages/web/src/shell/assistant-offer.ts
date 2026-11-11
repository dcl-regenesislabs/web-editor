import type { AiProviderInfo } from '@dcl-editor/contract'

export interface AssistantOffer {
  // whether this account may use the assistant; false until asked
  offered(): boolean
  // whether the current account has been asked about yet
  answered(): boolean
  probe(): Promise<void>
}

// Hidden until the service says this account may use it. Each probe asks afresh (an account change
// starts one), and only the latest one's answer counts.
export function createAssistantOffer(deps: {
  wallet: () => string | null
  providers: () => Promise<AiProviderInfo[]>
  changed: () => void
}): AssistantOffer {
  let offered = false
  let answered = false
  let latest = 0
  return {
    offered: () => offered,
    answered: () => answered,
    async probe() {
      const probe = ++latest
      answered = false
      const now = deps.wallet() !== null && (await deps.providers()).some((provider) => provider.available)
      if (probe !== latest) return
      offered = now
      answered = true
      deps.changed()
    }
  }
}
