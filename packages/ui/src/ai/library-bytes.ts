// The shared material images and sounds buildModel and addSound copy into a project. Each host
// fetches them its own way: the web editor from next to its bundle, held to the build's hashes;
// the desktop app from its own files through the main process.
import type { LibraryName, MaterialMap } from '../three/materials'
import type { SoundName } from '../sounds'

export interface LibraryBytes {
  material(name: LibraryName, map: MaterialMap): Promise<Uint8Array<ArrayBuffer>>
  sound(name: SoundName): Promise<Uint8Array<ArrayBuffer>>
}

let library: LibraryBytes | null = null

export function setLibraryBytes(next: LibraryBytes): void {
  library = next
}

function current(): LibraryBytes {
  if (library === null) throw new Error('The shared library is not available here.')
  return library
}

export const materialBytes = (name: LibraryName, map: MaterialMap): Promise<Uint8Array<ArrayBuffer>> => current().material(name, map)
export const soundBytes = (name: SoundName): Promise<Uint8Array<ArrayBuffer>> => current().sound(name)
