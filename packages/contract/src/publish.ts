// ---- Publish in the page ----
// A shell with no CLI to drive (the web target) publishes by itself: it builds
// the scene, has the page that hosts the editor confirm and sign the entity id,
// and uploads to the Worlds content server. The editor never signs.
export interface PublishWorld {
  name: string // "name.dcl.eth"
  role: 'owner' | 'collaborator'
}

export interface PublishProgress {
  // `signing`: the hosting page is asking the creator to confirm
  step: 'building' | 'signing' | 'uploading'
  // for the build log
  line?: string
}

export interface PublishedScene {
  world: string
  entityId: string
  // opens the published world in this explorer
  url: string
  base?: string // the base parcel it landed on, "x,y"
  files: number
  bytes: number
  at: number // epoch ms
}

// `cancelled`: declined in the hosting page's confirmation, or stopped.
export type ScenePublishResult =
  | { ok: true; published: PublishedScene }
  | { ok: false; reason: 'cancelled' | 'not-signed-in' | 'failed'; message: string; retryable: boolean }
