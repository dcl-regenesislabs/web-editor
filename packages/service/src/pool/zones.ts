// Where a guest's scene may stand in a pool world: a square of parcels of its own.
// Zones are handed out from the far corner inward, away from 0,0 where the NAME's own
// scenes are, so the first ones lent are also the ones an explorer that reads only the
// first page of /scenes (bevy-explorer update_scene_urns: 100, oldest first) still loads.

// Worlds accepts parcels from -150 to 150 on both axes (worlds-content-server coordinates)
const WORLD_MIN = -150
const WORLD_MAX = 150

export interface Zone {
  x: number
  y: number
}

export interface ZoneGrid {
  size: number
  /** Every zone, in lending order. */
  zones: readonly Zone[]
  contains(zone: Zone, parcel: string): boolean
  /** The zone's key: its lowest corner. */
  anchor(zone: Zone): string
  parcels(zone: Zone): string[]
}

export function createZoneGrid(size: number, keepClear: number): ZoneGrid {
  const zones: Zone[] = []
  for (let y = WORLD_MIN; y + size - 1 <= WORLD_MAX; y += size) {
    for (let x = WORLD_MIN; x + size - 1 <= WORLD_MAX; x += size) {
      const clear = x > keepClear || x + size - 1 < -keepClear || y > keepClear || y + size - 1 < -keepClear
      if (clear) zones.push({ x, y })
    }
  }
  return {
    size,
    zones,
    contains(zone, parcel) {
      const [x, y] = parcel.split(',').map(Number)
      return x >= zone.x && x < zone.x + size && y >= zone.y && y < zone.y + size
    },
    anchor: (zone) => `${zone.x},${zone.y}`,
    parcels(zone) {
      const all: string[] = []
      for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) all.push(`${zone.x + dx},${zone.y + dy}`)
      return all
    }
  }
}
