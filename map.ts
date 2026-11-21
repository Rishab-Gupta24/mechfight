/** Static map model: terrain, solids, line of sight, walkability and A* pathfinding on a 1 m grid. */
import { readFileSync } from "node:fs"

export interface Roof {
  id: number
  top: number // roof height (world z)
  height: number // above surrounding ground
  center: [number, number] // deepest interior point (hiding spot)
  access: [number, number] // walkable ground point next to a wall to climb from
  edge: [number, number] // roof edge point nearest the access point (climb toward it)
  interior: number // metres from center to nearest edge
}

export class World {
  nx = 0
  ny = 0
  minX = 0
  minY = 0
  ground!: Float32Array // terrain height
  losTop!: Float32Array // top of ground-attached solids (or ground)
  bandBase!: Float32Array // overhead solid band (bridges, overhangs); NaN = none
  bandTop!: Float32Array
  blocked!: Uint8Array // not walkable at all
  clear!: Float32Array // distance (m) to nearest blocked cell
  bx0 = 0
  roofs: Roof[] = []
  roofId!: Int16Array // roof index per cell, -1 = none
  roofDist!: Uint8Array // metres to that roof's edge (0 = not on a roof)
  bx1 = 0
  by0 = 0
  by1 = 0

  constructor(dir: string) {
    const w = JSON.parse(readFileSync(`${dir}/v2/world.json`, "utf8"))
    const t = w.terrain
    this.nx = t.nx
    this.ny = t.ny
    this.minX = t.minX
    this.minY = t.minY
    this.bx0 = w.bounds.minX
    this.bx1 = w.bounds.maxX
    this.by0 = w.bounds.minY
    this.by1 = w.bounds.maxY
    const n = this.nx * this.ny
    const buf = readFileSync(`${dir}/v2/terrain.i16`)
    const ground = new Float32Array(n)
    const scale = t.scale ?? 0.01
    for (let i = 0; i < n; i++) ground[i] = buf.readInt16LE(i * 2) * scale
    this.ground = ground
    const losTop = Float32Array.from(ground)
    const surf = Float32Array.from(ground)
    const solid = new Uint8Array(n)
    const bandBase = new Float32Array(n).fill(NaN)
    const bandTop = new Float32Array(n).fill(NaN)
    for (const p of w.prisms) {
      const isBridge = p.kind === "bridge"
      this.raster(p.ring, p.holes ?? [], (c) => {
        const g = ground[c]
        if (isBridge) {
          if (p.top - g <= 2.5 && p.base - g < 9) surf[c] = Math.max(surf[c], p.top)
          else if (p.base - g < 9) solid[c] = 1
          if (isNaN(bandBase[c]) || p.base < bandBase[c]) bandBase[c] = p.base
          if (isNaN(bandTop[c]) || p.top > bandTop[c]) bandTop[c] = p.top
          return
        }
        if (p.base <= g + 1.5) {
          if (p.top > losTop[c]) losTop[c] = p.top
          if (p.top - g > 1.2) solid[c] = 1
          else surf[c] = Math.max(surf[c], p.top)
        } else {
          if (isNaN(bandBase[c]) || p.base < bandBase[c]) bandBase[c] = p.base
          if (isNaN(bandTop[c]) || p.top > bandTop[c]) bandTop[c] = p.top
          if (p.base - g < 9.5) solid[c] = 1
        }
      })
    }
    this.losTop = losTop
    this.bandBase = bandBase
    this.bandTop = bandTop
    const blocked = new Uint8Array(n)
    const nx = this.nx
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i
        const x = this.minX + i
        const y = this.minY + j
        if (solid[c] || i === 0 || j === 0 || i === nx - 1 || j === this.ny - 1 || x < this.bx0 + 3 || x > this.bx1 - 3 || y < this.by0 + 3 || y > this.by1 - 3) {
          blocked[c] = 1
          continue
        }
        const s = surf[c]
        if (Math.abs(surf[c + 1] - s) > 1.25 || Math.abs(surf[c - 1] - s) > 1.25 || Math.abs(surf[c + nx] - s) > 1.25 || Math.abs(surf[c - nx] - s) > 1.25) blocked[c] = 1
      }
    this.blocked = blocked
    this.clear = chamfer(blocked, nx, this.ny)
    this.buildRoofs(w.prisms)
    this.gs = new Float32Array(n)
    this.from = new Int32Array(n)
    this.stamp = new Uint32Array(n)
    this.closedStamp = new Uint32Array(n)
    // warm up the JIT so the first in-match search is not slow
    for (let k = 0; k < 3; k++) this.path(0, 0, 60, 40, 3000)
  }

  /** Even-odd scanline fill of a polygon (flat ring) with holes over grid vertices. */
  private raster(ring: number[], holes: number[][], fn: (c: number) => void) {
    const polys = [ring, ...holes]
    let y0 = Infinity
    let y1 = -Infinity
    for (let k = 1; k < ring.length; k += 2) {
      y0 = Math.min(y0, ring[k])
      y1 = Math.max(y1, ring[k])
    }
    const j0 = Math.max(0, Math.ceil(y0 - this.minY))
    const j1 = Math.min(this.ny - 1, Math.floor(y1 - this.minY))
    const xs: number[] = []
    for (let j = j0; j <= j1; j++) {
      const y = this.minY + j
      xs.length = 0
      for (const pl of polys) {
        const m = pl.length / 2
        for (let a = 0; a < m; a++) {
          const b = (a + 1) % m
          const ax = pl[2 * a], ay = pl[2 * a + 1], bx = pl[2 * b], by = pl[2 * b + 1]
          if (ay <= y !== by <= y) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax))
        }
      }
      xs.sort((p, q) => p - q)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] - this.minX))
        const i1 = Math.min(this.nx - 1, Math.floor(xs[k + 1] - this.minX))
        for (let i = i0; i <= i1; i++) fn(j * this.nx + i)
      }
    }
  }

  /** Flat building tops 8-45 m up with a deep interior and a climbable wall next to open ground. */
  private buildRoofs(prisms: any[]) {
    const n = this.nx * this.ny, nx = this.nx
    this.roofId = new Int16Array(n).fill(-1)
    this.roofDist = new Uint8Array(n)
    for (const p of prisms) {
      if (p.kind !== "building") continue
      const cells: number[] = []
      this.raster(p.ring, p.holes ?? [], (c) => {
        if (Math.abs(this.losTop[c] - p.top) < 0.3 && isNaN(this.bandBase[c])) cells.push(c)
      })
      if (cells.length < 150) continue
      const gs = cells.map((c) => this.ground[c]).sort((a, b) => a - b)
      const height = p.top - gs[Math.floor(gs.length / 2)]
      if (height < 8 || height > 45) continue
      const set = new Set(cells)
      const dist = new Map<number, number>()
      let frontier = cells.filter((c) => !set.has(c + 1) || !set.has(c - 1) || !set.has(c + nx) || !set.has(c - nx))
      for (const c of frontier) dist.set(c, 1)
      let d = 1
      while (frontier.length) {
        const nf: number[] = []
        d++
        for (const c of frontier) for (const m of [c + 1, c - 1, c + nx, c - nx]) if (set.has(m) && !dist.has(m)) {
          dist.set(m, d)
          nf.push(m)
        }
        frontier = nf
      }
      let best = -1, bd = 0
      for (const [c, v] of dist) if (v > bd) {
        bd = v
        best = c
      }
      if (bd < 6) continue
      const bx = this.minX + (best % nx), by = this.minY + Math.floor(best / nx)
      let acc: [number, number] | null = null, edge: [number, number] | null = null, ad = 1e9
      for (const [c, v] of dist) {
        if (v !== 1) continue
        const ex = this.minX + (c % nx), ey = this.minY + Math.floor(c / nx)
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2
          for (const r of [3.5, 4.5, 5.5]) {
            const gx = ex + Math.cos(a) * r, gy = ey + Math.sin(a) * r
            if (!this.walkable(gx, gy, 3)) continue
            const dd = Math.hypot(gx - bx, gy - by)
            if (dd < ad) {
              ad = dd
              acc = [gx, gy]
              edge = [ex, ey]
            }
          }
        }
      }
      if (!acc || !edge) continue
      const id = this.roofs.length
      this.roofs.push({ id, top: p.top, height, center: [bx, by], access: acc, edge, interior: bd })
      for (const [c, v] of dist) {
        this.roofId[c] = id
        this.roofDist[c] = Math.min(255, v)
      }
    }
  }

  /** Roof index under (x, y) if standing at height z on it, else -1. */
  roofAt(x: number, y: number, z: number): number {
    const c = this.cell(x, y)
    if (c < 0) return -1
    const id = this.roofId[c]
    if (id < 0 || Math.abs(this.roofs[id].top - z) > 1.5) return -1
    return id
  }

  cell(x: number, y: number): number {
    const i = Math.round(x - this.minX)
    const j = Math.round(y - this.minY)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1
    return j * this.nx + i
  }

  groundAt(x: number, y: number): number {
    const c = this.cell(x, y)
    return c < 0 ? 0 : this.ground[c]
  }

  clearAt(x: number, y: number): number {
    const c = this.cell(x, y)
    return c < 0 ? 0 : this.clear[c]
  }

  walkable(x: number, y: number, r = 2.8): boolean {
    const c = this.cell(x, y)
    return c >= 0 && this.clear[c] >= r
  }

  /** Line of sight / shot path through buildings, terrain and bridges (trees ignored). */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number, endSkip = 2.5): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L = Math.hypot(dx, dy)
    const steps = Math.ceil(L / 0.8)
    if (steps <= 1) return true
    const skipEnd = Math.max(0, L - endSkip)
    for (let s = 1; s < steps; s++) {
      const f = s / steps
      if (f * L > skipEnd) break
      const c = this.cell(ax + dx * f, ay + dy * f)
      if (c < 0) return false
      const z = az + dz * f
      if (z < this.losTop[c]) return false
      const bb = this.bandBase[c]
      if (bb === bb && z >= bb && z <= this.bandTop[c]) return false
    }
    return true
  }

  /** Straight walk between two points stays on cells with clearance >= r. */
  walkLine(ax: number, ay: number, bx: number, by: number, r = 2.8): boolean {
    const L = Math.hypot(bx - ax, by - ay)
    const steps = Math.max(1, Math.ceil(L / 0.7))
    for (let s = 0; s <= steps; s++) {
      const f = s / steps
      const c = this.cell(ax + (bx - ax) * f, ay + (by - ay) * f)
      if (c < 0 || this.clear[c] < r) return false
    }
    return true
  }

  /** Nearest cell with clearance >= r (spiral search). */
  nearestFree(x: number, y: number, r = 3, maxR = 40): [number, number] | null {
    if (this.walkable(x, y, r)) return [x, y]
    for (let rad = 1; rad <= maxR; rad++) {
      const n = Math.max(8, Math.round(rad * 6))
      let best: [number, number] | null = null
      let bc = -1
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2
        const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad
        const c = this.cell(px, py)
        if (c >= 0 && this.clear[c] >= r && this.clear[c] > bc) {
          bc = this.clear[c]
          best = [px, py]
        }
      }
      if (best) return best
    }
    return null
  }

  // ---------- A* ----------
  private gs?: Float32Array
  private from?: Int32Array
  private stamp?: Uint32Array
  private closedStamp?: Uint32Array
  private gen = 0
  private heap = new Int32Array(1 << 20)
  private heapF = new Float32Array(1 << 20)

  /** A* from (sx,sy) to (gx,gy). Returns world points (every cell), possibly partial (closest reached). */
  path(sx: number, sy: number, gx: number, gy: number, maxExpand = 40000, r = 2.8): [number, number][] {
    const n = this.nx * this.ny
    if (!this.gs) {
      this.gs = new Float32Array(n)
      this.from = new Int32Array(n)
      this.stamp = new Uint32Array(n)
      this.closedStamp = new Uint32Array(n)
    }
    const gs = this.gs!, from = this.from!, stamp = this.stamp!, closed = this.closedStamp!
    const s0 = this.nearestFree(sx, sy, r, 30)
    const g0 = this.nearestFree(gx, gy, r, 40)
    if (!s0 || !g0) return []
    const start = this.cell(s0[0], s0[1])
    const goal = this.cell(g0[0], g0[1])
    const nx = this.nx
    const gi = goal % nx, gj = (goal / nx) | 0
    this.gen++
    const gen = this.gen
    const heap = this.heap, heapF = this.heapF
    let hn = 0
    const push = (c: number, f: number) => {
      let i = hn++
      while (i > 0) {
        const p = (i - 1) >> 1
        if (heapF[p] <= f) break
        heap[i] = heap[p]
        heapF[i] = heapF[p]
        i = p
      }
      heap[i] = c
      heapF[i] = f
    }
    const pop = (): number => {
      const top = heap[0]
      hn--
      if (hn > 0) {
        const c = heap[hn], f = heapF[hn]
        let i = 0
        for (;;) {
          let l = 2 * i + 1
          if (l >= hn) break
          if (l + 1 < hn && heapF[l + 1] < heapF[l]) l++
          if (heapF[l] >= f) break
          heap[i] = heap[l]
          heapF[i] = heapF[l]
          i = l
        }
        heap[i] = c
        heapF[i] = f
      }
      return top
    }
    const H = (c: number) => {
      const di = Math.abs((c % nx) - gi), dj = Math.abs(((c / nx) | 0) - gj)
      return (Math.max(di, dj) + 0.4142 * Math.min(di, dj)) * 1.15
    }
    gs[start] = 0
    stamp[start] = gen
    from[start] = -1
    push(start, H(start))
    let best = start
    let bestH = H(start)
    let expanded = 0
    const DI = [1, -1, 0, 0, 1, 1, -1, -1]
    const DJ = [0, 0, 1, -1, 1, -1, 1, -1]
    const clear = this.clear
    while (hn > 0 && expanded < maxExpand && hn < heap.length - 16) {
      const c = pop()
      if (closed[c] === gen) continue
      closed[c] = gen
      expanded++
      if (c === goal) {
        best = c
        break
      }
      const h = H(c)
      if (h < bestH) {
        bestH = h
        best = c
      }
      const ci = c % nx
      const g = gs[c]
      for (let k = 0; k < 8; k++) {
        const ni = ci + DI[k]
        if (ni < 0 || ni >= nx) continue
        const nb = c + DI[k] + DJ[k] * nx
        if (nb < 0 || nb >= clear.length) continue
        const cl = clear[nb]
        if (cl < r || closed[nb] === gen) continue
        if (k >= 4 && (clear[c + DI[k]] < r || clear[c + DJ[k] * nx] < r)) continue
        const step = (k < 4 ? 1 : 1.4142) * (1 + (cl < 7 ? (7 - cl) * 0.12 : 0))
        const ng = g + step
        if (stamp[nb] !== gen || ng < gs[nb]) {
          stamp[nb] = gen
          gs[nb] = ng
          from[nb] = c
          push(nb, ng + H(nb))
        }
      }
    }
    const out: [number, number][] = []
    let c = best
    let guard = 0
    while (c !== -1 && guard++ < 200000) {
      out.push([this.minX + (c % nx), this.minY + ((c / nx) | 0)])
      if (c === start) break
      c = from[c]
    }
    out.reverse()
    return out
  }
}

/** Two-pass chamfer distance transform (distance to nearest blocked cell, metres). */
function chamfer(blocked: Uint8Array, nx: number, ny: number): Float32Array {
  const INF = 1e6
  const d = new Float32Array(nx * ny)
  for (let i = 0; i < d.length; i++) d[i] = blocked[i] ? 0 : INF
  const a = 1, b = 1.4142
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i
      let v = d[c]
      if (v === 0) continue
      if (i > 0) v = Math.min(v, d[c - 1] + a)
      if (j > 0) {
        v = Math.min(v, d[c - nx] + a)
        if (i > 0) v = Math.min(v, d[c - nx - 1] + b)
        if (i < nx - 1) v = Math.min(v, d[c - nx + 1] + b)
      }
      d[c] = v
    }
  for (let j = ny - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const c = j * nx + i
      let v = d[c]
      if (v === 0) continue
      if (i < nx - 1) v = Math.min(v, d[c + 1] + a)
      if (j < ny - 1) {
        v = Math.min(v, d[c + nx] + a)
        if (i < nx - 1) v = Math.min(v, d[c + nx + 1] + b)
        if (i > 0) v = Math.min(v, d[c + nx - 1] + b)
      }
      d[c] = v
    }
  return d
}
