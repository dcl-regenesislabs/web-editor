import type { ModelPreview } from '@dcl-editor/contract'

export const MODEL_BUDGET = { triangles: 8000, materials: 6, textures: 4, largestTexture: 512 }

export interface ModelStats {
  triangles: number
  materials: number
  textures: number
  largestTexture: number
}

export type ThreeRequest =
  // name: the model's, which its unnamed parts are named after
  | { kind: 'build'; code: string; name: string }
  | { kind: 'preview'; bytes: ArrayBuffer; files: Record<string, ArrayBuffer> }
  // the preview: a canvas the worker draws on, and the model's bytes
  // files: what the model points at, by the uri it uses (a built model's shared materials)
  | { kind: 'view'; canvas: OffscreenCanvas; bytes: ArrayBuffer; files?: Record<string, ArrayBuffer>; width: number; height: number; dpr: number }
  | { kind: 'clip'; name: string }
  | { kind: 'orbit'; dx: number; dy: number }
  | { kind: 'zoom'; delta: number }
  | { kind: 'resize'; width: number; height: number }

export type ThreeReply =
  // the worker holds the port: transfers sent before this can be lost on the way
  | { kind: 'ready' }
  // library: the shared materials this model points at, whose files the page writes beside it
  // warnings: what the worker changed so the model meets Decentraland's rules
  | { kind: 'built'; glb: ArrayBuffer; clips: string[]; library: string[]; warnings: string[] }
  | { kind: 'shown' }
  | { kind: 'previewed'; preview: ModelPreview }
  | { kind: 'failed'; error: string }
