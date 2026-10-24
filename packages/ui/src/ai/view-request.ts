// The view tool's arguments, apart from the capture so the web's tool parsing loads without an engine.
export interface Point {
  x: number
  y: number
  z: number
}

export interface ViewRequest {
  target?: 'editor' | 'mobile'
  openIfClosed?: boolean
  entity: string | null
  // the free camera moved here, in world metres, looking at lookAt (or keeping its aim)
  from: Point | null
  lookAt: Point | null
}

function point(value: unknown): Point | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y, z } = value as Record<string, unknown>
  return [x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n)) ? { x: x as number, y: y as number, z: z as number } : null
}

export function viewRequest(args: Record<string, unknown>): ViewRequest {
  if (args.target !== undefined && args.target !== 'editor' && args.target !== 'mobile') throw new Error('Unknown view target.')
  return {
    ...(args.target === undefined ? {} : { target: args.target }),
    ...(args.openIfClosed === true ? { openIfClosed: true } : {}),
    entity: typeof args.entity === 'string' && args.entity.trim() !== '' ? args.entity : null,
    from: point(args.from),
    lookAt: point(args.lookAt)
  }
}
