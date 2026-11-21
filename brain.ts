/** mechfight bot: zone-aware survivor that loots, farms, fights at range with lead, and retreats to cover to regen. */
import { type Action, type ActorObs, draw, type Hello, log, type Observation } from "./mechfight.ts"
import { World } from "./map.ts"

type V2 = [number, number]
const TAU = Math.PI * 2
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const hyp = Math.hypot
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

const UPGRADE_PRIORITY = [
  "gun_damage", "laser_damage", "gun_rate", "armor", "laser_charge", "plating", "lightning_efficiency",
  "mortar_reload", "gun_velocity", "nanites", "gyros", "gun_mag", "servos", "lightning_range", "sensors",
  "reactor", "capacitor", "jets", "lightning_chain", "mortar_velocity", "mortar_splash", "laser_pierce",
]
const WEAPON_VALUE: Record<string, number> = { laser: 3, lightning: 2.4, mortar: 1.6, gun: 2.2 }

interface Track {
  id: number
  pos: number[]
  vel: number[]
  hp: number
  maxHp: number
  weapons: string[]
  cubes: number
  seen: number // last time listed
  hurtMe: number // last time it damaged me
  charging: boolean
  aim: number[]
}

export const P = {
  selective: 0, // only engage hostile / favourable targets
  fleeFrac: 0.4,
  fleeRatio: 0.8,
  resumeFrac: 0.85,
  prefGun: 90,
  prefLaser: 120,
  peek: 1,
  farm: 0,
  armWait: 1, // avoid starting fights until a second weapon is held (or t > armT)
  armT: 60,
  hide: 0, // never start fights: avoid, stay quiet, survive
}

export class Brain {
  name = "oval-survivor"
  cfg: any
  world: World | null = null
  me: any
  t = 0
  tracks = new Map<number, Track>()
  lastHurt = -99
  lastHurtBearing = 0
  lastDealt = -99
  strafeSign = 1
  strafeUntil = 0
  path: V2[] = []
  pathGoal: V2 | null = null
  pathIdx = 0
  pathTime = -99
  posHist: { t: number; x: number; y: number; cmd: number }[] = []
  unstickUntil = -99
  unstickDir: V2 = [1, 0]
  fleeing = false
  coverPt: V2 | null = null
  coverTime = -99
  sweep = 0
  rng: () => number
  lastAimCmd: V2 = [0, 0]
  heardBearing = 0
  heardTime = -99
  dropFailed = new Set<number>()
  takeFail = new Map<number, number>()
  lootTarget: { kind: string; id: number; pos: number[] } | null = null
  lootPickTime = -99
  lastMoveDir: V2 = [1, 0]
  peekSpot: V2 | null = null
  hideSpot: V2 | null = null
  peekTime = -99
  peekFor = -1
  hiding = false
  explore: V2 | null = null
  exploreTime = -99
  visited = new Set<number>()
  t0 = 0
  /** True when this decision has already used more than ms milliseconds. */
  over(ms: number) {
    return performance.now() - this.t0 > ms
  }

  constructor(hello: Hello) {
    this.cfg = hello.config
    let s = (hello.seed >>> 0) || 1
    this.rng = () => {
      s ^= s << 13
      s >>>= 0
      s ^= s >>> 17
      s ^= s << 5
      s >>>= 0
      return s / 4294967296
    }
    try {
      this.world = new World(hello.map.dir)
    } catch (e) {
      log("map load failed", e)
    }
  }

  // ---------------- helpers ----------------
  scale(cubes: number) {
    return 1 + (this.cfg.cubes.size_per_cube ?? 0.05) * cubes
  }
  centerZ(m: ActorObs | Track | any): number {
    if (m.kind === "npc") return m.pos[2] + 1.75
    return m.pos[2] + 4.5 * this.scale(m.cubes ?? 0)
  }
  los(a: number[], az: number, b: number[], bz: number) {
    return this.world ? this.world.los(a[0], a[1], az, b[0], b[1], bz) : true
  }
  dist2(a: number[], b: number[]) {
    return hyp(a[0] - b[0], a[1] - b[1])
  }

  /** Circle we want to be inside right now. */
  safeCircle(obs: Observation): { c: V2; r: number; hard: { c: V2; r: number } } {
    const z = obs.zone
    const t = obs.t
    let cc: V2 = [z.center[0], z.center[1]]
    let cr = z.radius
    if (t >= z.shrink_start) {
      const f = clamp((t - z.shrink_start) / Math.max(0.01, z.shrink_end - z.shrink_start), 0, 1)
      cc = [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f]
      cr = z.radius + (z.next_radius - z.radius) * f
    }
    const nr = z.next_radius
    const margin = Math.min(30, nr * 0.3)
    const want = { c: [z.next_center[0], z.next_center[1]] as V2, r: Math.max(0, nr - margin) }
    return { c: want.c, r: want.r, hard: { c: cc, r: cr } }
  }

  // ---------------- navigation ----------------
  /** Returns a move direction (unit-ish) toward goal using A* with caching. */
  navTo(gx: number, gy: number, urgent = false): V2 {
    const [x, y] = this.me.pos
    const d = hyp(gx - x, gy - y)
    if (d < 1.5) return [0, 0]
    const w = this.world
    if (!w) return [(gx - x) / d, (gy - y) / d]
    if (d < 70 && w.walkLine(x, y, gx, gy, 2.6)) {
      this.path = []
      return [(gx - x) / d, (gy - y) / d]
    }
    const goalMoved = !this.pathGoal || hyp(this.pathGoal[0] - gx, this.pathGoal[1] - gy) > Math.max(6, d * 0.15)
    let off = false
    if (this.path.length) {
      const p = this.path[Math.min(this.pathIdx, this.path.length - 1)]
      off = hyp(p[0] - x, p[1] - y) > 10
    }
    if (!this.path.length || goalMoved || off || this.t - this.pathTime > 4) {
      if ((this.t - this.pathTime > 0.45 || !this.path.length || urgent) && !this.over(12)) {
        this.path = w.path(x, y, gx, gy, 14000)
        this.pathGoal = [gx, gy]
        this.pathIdx = 0
        this.pathTime = this.t
      }
    }
    if (!this.path.length) return [(gx - x) / d, (gy - y) / d]
    // advance index to closest point
    let bi = this.pathIdx
    let bd = 1e9
    for (let i = this.pathIdx; i < Math.min(this.path.length, this.pathIdx + 40); i++) {
      const p = this.path[i]
      const dd = hyp(p[0] - x, p[1] - y)
      if (dd < bd) {
        bd = dd
        bi = i
      }
    }
    this.pathIdx = bi
    // lookahead: farthest visible point
    let tx = this.path[this.path.length - 1][0], ty = this.path[this.path.length - 1][1]
    let found = false
    for (let i = Math.min(this.path.length - 1, bi + 45); i > bi; i -= 2) {
      const p = this.path[i]
      if (w.walkLine(x, y, p[0], p[1], 2.4)) {
        tx = p[0]
        ty = p[1]
        found = true
        break
      }
    }
    if (!found && bi + 1 < this.path.length) {
      tx = this.path[bi + 1][0]
      ty = this.path[bi + 1][1]
    }
    const dd = hyp(tx - x, ty - y)
    if (dd < 0.3) return [(gx - x) / d, (gy - y) / d]
    return [(tx - x) / dd, (ty - y) / dd]
  }

  /** Adjust a direct move so it does not run into walls (for strafing). */
  safeDir(dx: number, dy: number, look = 6): V2 {
    const w = this.world
    const L = hyp(dx, dy)
    if (!w || L < 1e-6) return [dx, dy]
    const [x, y] = this.me.pos
    const base = Math.atan2(dy, dx)
    for (const off of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.2, -2.2, Math.PI]) {
      const a = base + off
      const ex = x + Math.cos(a) * look, ey = y + Math.sin(a) * look
      if (w.walkLine(x, y, ex, ey, 2.6)) return [Math.cos(a) * L, Math.sin(a) * L]
    }
    return [dx, dy]
  }

  // ---------------- cover ----------------
  findCover(threats: Track[], circle: { c: V2; r: number }): V2 | null {
    const w = this.world
    if (!w || !threats.length) return null
    const [x, y] = this.me.pos
    let best: V2 | null = null
    let bestS = 1e9
    for (const R of [12, 22, 34, 48, 65]) {
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * TAU + R * 0.1
        const px = x + Math.cos(a) * R, py = y + Math.sin(a) * R
        if (!w.walkable(px, py, 3)) continue
        const dc = hyp(px - circle.c[0], py - circle.c[1])
        const zonePen = dc > circle.r ? (dc - circle.r) * 3 : 0
        const gz = w.groundAt(px, py)
        let exposed = 0
        let nearPen = 0
        for (const th of threats) {
          const ez = th.pos[2] + 8
          if (w.los(th.pos[0], th.pos[1], ez, px, py, gz + 7)) exposed++
          const dt = hyp(th.pos[0] - px, th.pos[1] - py)
          if (dt < 40) nearPen += (40 - dt) * 1.5
        }
        if (exposed) continue
        const s = R + zonePen + nearPen + (w.walkLine(x, y, px, py, 2.6) ? 0 : 15)
        if (s < bestS) {
          bestS = s
          best = [px, py]
        }
      }
      if (best && bestS < R + 25) break
    }
    return best
  }

  // ---------------- main ----------------
  act(obs: Observation): Omit<Action, "tick"> {
    this.t0 = performance.now()
    const me = obs.self
    this.me = me
    this.t = obs.t
    const [x, y, z] = me.pos
    const act: Omit<Action, "tick"> = {}
    const cfg = this.cfg
    const w = this.world

    // ---- offers ----
    if (obs.offer) {
      let bi = 0
      let bp = 1e9
      obs.offer.choices.forEach((c, i) => {
        const p = UPGRADE_PRIORITY.indexOf(c.id)
        const pp = p < 0 ? 50 : p
        if (pp < bp) {
          bp = pp
          bi = i
        }
      })
      act.pick = bi
    }

    // ---- events ----
    for (const e of obs.events) {
      if (e.type === "damaged") {
        if (e.weapon !== "zone") {
          this.lastHurt = this.t
          if (e.bearing != null) this.lastHurtBearing = e.bearing
          if (e.by != null) {
            const tr = this.tracks.get(e.by)
            if (tr) tr.hurtMe = this.t
            else
              this.tracks.set(e.by, { id: e.by, pos: [x + Math.cos(e.bearing ?? 0) * 80, y + Math.sin(e.bearing ?? 0) * 80, z], vel: [0, 0, 0], hp: 1400, maxHp: 1400, weapons: [e.weapon], cubes: 0, seen: -99, hurtMe: this.t, charging: false, aim: [0, 0] })
          }
        }
      } else if (e.type === "hit") this.lastDealt = this.t
      else if (e.type === "take_failed") this.takeFail.set(e.id, this.t)
    }
    for (const s of obs.sounds) {
      if (["gun", "laser", "lightning", "mortar", "laser_charge", "boost", "step", "jet"].includes(s.kind) && (s.dist !== "far" || s.kind === "laser")) {
        this.heardBearing = s.bearing
        this.heardTime = this.t
      }
    }

    // ---- tracks ----
    for (const m of obs.mechs) {
      if (m.kind !== "mech") continue
      const tr = this.tracks.get(m.id)
      const rec: Track = {
        id: m.id, pos: m.pos, vel: m.vel, hp: m.hp ?? 1400, maxHp: m.max_hp ?? 1400, weapons: m.weapons ?? [], cubes: m.cubes ?? 0,
        seen: this.t, hurtMe: tr ? tr.hurtMe : -99, charging: !!m.charging, aim: m.aim,
      }
      this.tracks.set(m.id, rec)
    }
    for (const [id, tr] of this.tracks) if (this.t - Math.max(tr.seen, tr.hurtMe) > 12) this.tracks.delete(id)
    const listed = new Set(obs.mechs.filter((m) => m.kind === "mech").map((m) => m.id))
    const enemies = [...this.tracks.values()].filter((t) => listed.has(t.id))
    const ghosts = [...this.tracks.values()].filter((t) => !listed.has(t.id) && this.t - t.hurtMe < 6)

    // ---- weapons ----
    const wps = me.weapons
    let gunSlot = -1, laserSlot = -1, lightSlot = -1, mortarSlot = -1
    wps.forEach((wp, i) => {
      if (!wp) return
      if (wp.kind === "gun") gunSlot = i
      else if (wp.kind === "laser") laserSlot = i
      else if (wp.kind === "lightning") lightSlot = i
      else if (wp.kind === "mortar") mortarSlot = i
    })
    const scaleMe = this.scale(me.cubes)
    const muzzleZ = z + (me.stats.muzzle_height ?? 7 * scaleMe)
    const eyeZ = z + (me.stats.eye_height ?? 8 * scaleMe)

    // ---- zone ----
    const zc = this.safeCircle(obs)
    const dZone = hyp(x - zc.c[0], y - zc.c[1])
    const dHard = hyp(x - zc.hard.c[0], y - zc.hard.c[1])
    const timeToShrink = obs.zone.shrink_start - this.t
    const speed = me.stats.walk_speed ?? 11.7
    const needTravel = Math.max(0, dZone - zc.r) / speed
    const zoneUrgent = !me.in_zone || dHard > zc.hard.r - 8 || (dZone > zc.r && needTravel + 12 > timeToShrink)
    const inWant = (p: number[], slack = 0) => hyp(p[0] - zc.c[0], p[1] - zc.c[1]) <= zc.r + slack

    // ---- target selection ----
    const hpFrac = me.hp / me.max_hp
    let target: Track | null = null
    let tScore = 1e9
    const hostile = (e: Track) => {
      if (P.hide || (P.armWait && !wps[1] && this.t < P.armT)) {
        const dh = hyp(e.pos[0] - x, e.pos[1] - y)
        return dh < 50 || (this.t - e.hurtMe < 5 && dh < 120)
      }
      if (!P.selective) return true
      const d = hyp(e.pos[0] - x, e.pos[1] - y)
      if (this.t - e.hurtMe < 10 || d < 55) return true
      const brg = Math.atan2(y - e.pos[1], x - e.pos[0])
      if (d < 190 && Math.abs(wrap(e.aim[0] - brg)) < 0.2) return true
      if (d < 160 && e.hp / e.maxHp < 0.45) return true
      if (d < 130 && me.hp > e.hp * 1.35) return true
      return false
    }
    for (const e of enemies) {
      if (!hostile(e)) continue
      const d = hyp(e.pos[0] - x, e.pos[1] - y)
      const vis = this.los(me.pos, muzzleZ, e.pos, this.centerZ(e))
      let s = d + (e.hp / e.maxHp) * 60 + (vis ? 0 : 250) - (this.t - e.hurtMe < 4 ? 40 : 0)
      if (s < tScore) {
        tScore = s
        target = e
      }
    }
    const tDist = target ? hyp(target.pos[0] - x, target.pos[1] - y) : 1e9
    const tVis = target ? this.los(me.pos, muzzleZ, target.pos, this.centerZ(target)) : false

    // threats for flee logic
    const near = enemies.filter((e) => hyp(e.pos[0] - x, e.pos[1] - y) < 160)
    const enemyHp = near.reduce((s, e) => s + e.hp, 0)
    const recentlyHurt = this.t - this.lastHurt < 3
    if (!this.fleeing) {
      const tHp = target ? target.hp : enemyHp
      if (near.length && ((hpFrac < P.fleeFrac && tHp > me.hp * P.fleeRatio) || (hpFrac < 0.25 && enemyHp > me.hp * 0.7) || (near.length >= 3 && hpFrac < 0.75) || (near.length >= 2 && hpFrac < 0.5))) this.fleeing = true
    } else {
      if (hpFrac > P.resumeFrac || (!near.length && !recentlyHurt && hpFrac > 0.6)) this.fleeing = false
      // cornered: enemy very close and weak -> fight
      if (target && tDist < 30 && target.hp < me.hp * 0.8) this.fleeing = false
    }

    // ---- aim + fire ----
    let aimYaw = this.lastAimCmd[0]
    let aimPitch = 0
    const fire: [boolean, boolean] = [false, false]
    let shootTarget: { pos: number[]; vel: number[]; cz: number; r: number; isMech: boolean } | null = null
    if (target && tVis && tDist < 260) shootTarget = { pos: target.pos, vel: target.vel, cz: this.centerZ(target), r: 2.5 * this.scale(target.cubes), isMech: true }

    // secondary targets (npcs, crates) when no mech engagement
    let farmTarget: { pos: number[]; vel: number[]; cz: number; r: number; isMech: boolean; id: number } | null = null
    const calm = !near.length && !recentlyHurt && hpFrac > 0.45
    if (!shootTarget && calm && !zoneUrgent && !P.hide) {
      let bd = 1e9
      for (const m of obs.mechs) {
        if (m.kind !== "npc") continue
        const d = hyp(m.pos[0] - x, m.pos[1] - y)
        if (d > (P.farm ? 160 : 110) || !inWant(m.pos, 40)) continue
        if (!this.los(me.pos, muzzleZ, m.pos, m.pos[2] + 1.75)) continue
        if (d < bd) {
          bd = d
          farmTarget = { pos: m.pos, vel: m.vel, cz: m.pos[2] + 1.75, r: 1.8, isMech: false, id: m.id }
        }
      }
      if (!farmTarget)
        for (const c of obs.crates) {
          const d = hyp(c.pos[0] - x, c.pos[1] - y)
          if (d > (P.farm ? 130 : 90) || !inWant(c.pos, 40)) continue
          if (!this.los(me.pos, muzzleZ, c.pos, c.pos[2] + 1.2)) continue
          if (d < bd) {
            bd = d
            farmTarget = { pos: c.pos, vel: [0, 0, 0], cz: c.pos[2] + 1.2, r: 1.4, isMech: false, id: c.id }
          }
        }
    }
    let farmGoal: { pos: number[]; npc: boolean } | null = null
    if (P.farm && calm && !zoneUrgent && me.cubes < 14) {
      let bd = 1e9
      for (const m of obs.mechs) {
        if (m.kind !== "npc") continue
        const d = hyp(m.pos[0] - x, m.pos[1] - y)
        if (d < 200 && inWant(m.pos, 20) && d < bd) {
          bd = d
          farmGoal = { pos: m.pos, npc: true }
        }
      }
      for (const c of obs.crates) {
        const d = hyp(c.pos[0] - x, c.pos[1] - y) + 25
        if (w && c.pos[2] - w.groundAt(c.pos[0], c.pos[1]) > 2.5) continue
        if (d < 180 && inWant(c.pos, 20) && d < bd) {
          bd = d
          farmGoal = { pos: c.pos, npc: false }
        }
      }
    }
    const st = shootTarget ?? farmTarget
    const myAim = me.aim
    if (st) {
      const gun = gunSlot >= 0 ? wps[gunSlot]! : null
      const gspeed = gun ? gun.stats.speed : 252
      // gun lead
      let px = st.pos[0], py = st.pos[1], pz = st.cz
      const vz = clamp(st.vel[2] ?? 0, -15, 15)
      let tt = 0
      for (let k = 0; k < 4; k++) {
        const dd = hyp(px - x, py - y, pz - muzzleZ)
        tt = dd / gspeed + 0.05
        px = st.pos[0] + st.vel[0] * tt
        py = st.pos[1] + st.vel[1] * tt
        pz = st.cz + vz * tt * 0.5
      }
      const gYaw = Math.atan2(py - y, px - x)
      const gPitch = Math.atan2(pz - muzzleZ, hyp(px - x, py - y))
      // laser aim: current position + small latency lead
      const lx = st.pos[0] + st.vel[0] * 0.08, ly = st.pos[1] + st.vel[1] * 0.08
      const lYaw = Math.atan2(ly - y, lx - x)
      const lPitch = Math.atan2(st.cz - muzzleZ, hyp(lx - x, ly - y))
      const laser = laserSlot >= 0 ? wps[laserSlot]! : null
      const laserBusy = laser && (laser.charge ?? 0) > 0
      if (laserBusy) {
        aimYaw = lYaw
        aimPitch = lPitch
      } else {
        aimYaw = gYaw
        aimPitch = gPitch
      }
      const dist3 = hyp(st.pos[0] - x, st.pos[1] - y)
      const tol = Math.atan2(st.r * 0.75, dist3) + 0.004
      // gun
      if (gun && gun.cooldown <= 0.12 && (gun.reload ?? 0) <= 0 && (gun.ammo ?? 1) > 0 && dist3 < gun.stats.range * 0.98) {
        const e1 = Math.abs(wrap(myAim[0] - gYaw)), e2 = Math.abs(myAim[1] - gPitch)
        if (e1 < tol * 1.6 && e2 < tol * 2 + 0.01) fire[gunSlot] = true
      }
      // laser
      if (laser) {
        const full = laser.stats.charge
        const ch = laser.charge ?? 0
        const e1 = Math.abs(wrap(myAim[0] - lYaw)), e2 = Math.abs(myAim[1] - lPitch)
        const aimed = e1 < tol * 1.3 && e2 < tol * 2 + 0.01
        const worth = st.isMech || dist3 < 120
        if (ch > 0) {
          // charging: release when full and aimed, or before auto-fire
          const release = (ch >= full - 0.02 && aimed) || ch >= full + (laser.stats.hold_s ?? 2) - 0.25
          fire[laserSlot] = !release
        } else if (laser.cooldown <= 0.05 && dist3 < laser.stats.range * 0.97 && worth) {
          fire[laserSlot] = true
        }
      }
      // lightning
      if (lightSlot >= 0) {
        const lw = wps[lightSlot]!
        const cone = ((lw.stats.cone_deg ?? 30) * Math.PI) / 180 / 2
        const reserve = this.fleeing ? 25 : 12
        if (lw.cooldown <= 0.05 && dist3 < lw.stats.range * 0.95 && Math.abs(wrap(myAim[0] - Math.atan2(st.pos[1] - y, st.pos[0] - x))) < cone * 0.8 && me.energy > (lw.stats.energy ?? 3) + reserve)
          fire[lightSlot] = true
      }
      // mortar (mechs only, at range)
      if (mortarSlot >= 0 && st.isMech && dist3 > 28 && dist3 < 230) {
        const mw = wps[mortarSlot]!
        const sol = this.mortarSolve(mw.stats, st, z + 9.5 * scaleMe)
        if (sol && mw.cooldown <= 0.1) {
          // mortar shares the torso aim; only use when gun/laser not mid-action
          if (!(laser && (laser.charge ?? 0) > 0) && (!gun || (gun.ammo ?? 0) === 0 || (gun.reload ?? 0) > 0 || dist3 > 150 || !tVis)) {
            aimYaw = sol[0]
            aimPitch = sol[1]
            if (Math.abs(wrap(myAim[0] - sol[0])) < 0.03 && Math.abs(myAim[1] - sol[1]) < 0.03) fire[mortarSlot] = true
            fire[gunSlot >= 0 ? gunSlot : 0] = fire[gunSlot >= 0 ? gunSlot : 0] && false
          }
        }
      }
    } else {
      // no target: look toward threats / sounds / movement
      const laser = laserSlot >= 0 ? wps[laserSlot]! : null
      if (laser && (laser.charge ?? 0) > 0) {
        const ch = laser.charge ?? 0
        fire[laserSlot] = ch < laser.stats.charge + (laser.stats.hold_s ?? 2) - 0.3
      } else if (laser && target && laser.cooldown <= 0.05 && tDist < laser.stats.range && this.t - Math.max(target.seen, target.hurtMe) < 3 && this.hiding) {
        fire[laserSlot] = true // pre-charge behind cover, release on peek
      }
      if (target) {
        aimYaw = Math.atan2(target.pos[1] - y, target.pos[0] - x)
        aimPitch = Math.atan2(this.centerZ(target) - muzzleZ, tDist)
      } else if (this.t - this.lastHurt < 4) {
        aimYaw = this.lastHurtBearing
      } else if (ghosts.length) {
        aimYaw = Math.atan2(ghosts[0].pos[1] - y, ghosts[0].pos[0] - x)
      } else if (this.t - this.heardTime < 3) {
        aimYaw = this.heardBearing
      } else {
        this.sweep += 0.07
        const base = Math.atan2(this.lastMoveDir[1], this.lastMoveDir[0])
        aimYaw = base + Math.sin(this.sweep) * 1.4
      }
      // reload when idle
      if (gunSlot >= 0) {
        const g = wps[gunSlot]!
        if ((g.reload ?? 0) <= 0 && (g.ammo ?? 12) < g.stats.mag * 0.6) act.reload = true
      }
    }
    if (gunSlot >= 0) {
      const g = wps[gunSlot]!
      if ((g.ammo ?? 1) === 0 && (g.reload ?? 0) <= 0) act.reload = true
    }

    // ---- movement ----
    let move: V2 = [0, 0]
    let boost = false
    let jump = false
    let mode = "idle"
    const laserCharging = laserSlot >= 0 && (wps[laserSlot]!.charge ?? 0) > 0

    // mortar dodge vector
    let dodge: V2 = [0, 0]
    const mg = cfg.weapons.mortar.gravity ?? 22
    for (const p of obs.projectiles) {
      if (p.kind !== "mortar") continue
      let px = p.pos[0], py = p.pos[1], pz = p.pos[2], vx = p.vel[0], vy = p.vel[1], vz = p.vel[2]
      for (let k = 0; k < 80; k++) {
        px += vx * 0.1
        py += vy * 0.1
        vz -= mg * 0.1
        pz += vz * 0.1
        const gz = w ? w.groundAt(px, py) : 0
        if (pz <= gz + 0.5) break
      }
      const dd = hyp(px - x, py - y)
      if (dd < 12) {
        const k = (12 - dd) / 12
        dodge[0] += ((x - px) / (dd + 0.1)) * k * 2
        dodge[1] += ((y - py) / (dd + 0.1)) * k * 2
      }
    }

    // loot choice
    const wantLoot = this.chooseLoot(obs, inWant, near.length > 0)

    if (zoneUrgent) {
      mode = "zone"
      const tx = zc.c[0], ty = zc.c[1]
      move = this.navTo(tx, ty, true)
      boost = me.energy > 25 || !me.in_zone
    } else if (this.fleeing && near.length) {
      mode = "flee"
      if ((!this.coverPt || this.t - this.coverTime > 1.0) && !this.over(12)) {
        this.coverPt = this.findCover(near, { c: zc.c, r: Math.max(zc.r, 20) })
        this.coverTime = this.t
      }
      if (this.coverPt) {
        move = this.navTo(this.coverPt[0], this.coverPt[1], true)
        if (hyp(this.coverPt[0] - x, this.coverPt[1] - y) < 2.5) move = [0, 0]
      } else if (target) {
        // run away from target
        const ax = x - target.pos[0], ay = y - target.pos[1]
        const L = hyp(ax, ay) || 1
        move = this.safeDir(ax / L, ay / L, 8)
      }
      boost = me.energy > 20
    } else if (target && (tVis || this.t - target.hurtMe < 6 || tDist < 140 || target.hp / target.maxHp < 0.4)) {
      mode = "fight"
      // preferred range
      let pref = P.prefGun
      if (laserSlot >= 0) pref = P.prefLaser
      if (target.weapons.includes("lightning")) pref = Math.max(pref, 65)
      if (lightSlot >= 0 && !target.weapons.includes("mortar") && laserSlot < 0) pref = 30
      if (target.hp < me.hp * 0.5) pref = Math.min(pref, 60)
      const peekMove = P.peek ? this.peekFight(target, pref, wps, gunSlot, laserSlot, zc) : null
      if (peekMove) {
        move = peekMove
        mode = this.hiding ? "fight:hide" : "fight:peek"
        boost = me.energy > 35 && !laserCharging
      } else if (!tVis) {
        // get line of sight: path toward target
        move = this.navTo(target.pos[0], target.pos[1])
        boost = me.energy > 55 && tDist > 60
      } else {
        const bx = (target.pos[0] - x) / (tDist || 1), by = (target.pos[1] - y) / (tDist || 1)
        if (this.t > this.strafeUntil) {
          this.strafeSign = this.rng() < 0.5 ? -1 : 1
          this.strafeUntil = this.t + 0.5 + this.rng() * 1.1
        }
        const radial = clamp((tDist - pref) / 30, -1, 1)
        let mx = -by * this.strafeSign + bx * radial
        let my = bx * this.strafeSign + by * radial
        const L = hyp(mx, my) || 1
        mx /= L
        my /= L
        // keep in zone
        if (dZone > zc.r * 0.9 && zc.r > 5) {
          const zx = (zc.c[0] - x) / (dZone || 1), zy = (zc.c[1] - y) / (dZone || 1)
          mx = mx * 0.5 + zx * 0.7
          my = my * 0.5 + zy * 0.7
        }
        const sd = this.safeDir(mx, my, 6)
        if (sd[0] !== mx || sd[1] !== my) {
          if (this.rng() < 0.3) this.strafeSign *= -1
        }
        move = sd
        boost = me.energy > 45 && !laserCharging
      }
    } else if ((P.hide || (P.armWait && !wps[1] && this.t < P.armT)) && !target && (near.length || ghosts.length) && !wantLoot) {
      mode = "avoid"
      const th = near.length ? near : ghosts
      if (!this.coverPt || this.t - this.coverTime > 1.0) {
        this.coverPt = this.findCover(th, { c: zc.c, r: Math.max(zc.r, 20) })
        this.coverTime = this.t
      }
      if (this.coverPt && hyp(this.coverPt[0] - x, this.coverPt[1] - y) > 2) {
        move = this.navTo(this.coverPt[0], this.coverPt[1])
        const closest = Math.min(...th.map((e) => hyp(e.pos[0] - x, e.pos[1] - y)))
        if (closest > 90) move = [move[0] * 0.4, move[1] * 0.4] // walk quietly
        else boost = me.energy > 40
      }
    } else if (P.farm && calm && !zoneUrgent && farmGoal) {
      const fg = farmGoal
      const d = hyp(fg.pos[0] - x, fg.pos[1] - y)
      const stand = fg.npc ? 55 : 30
      const vis = this.los(me.pos, muzzleZ, fg.pos, fg.pos[2] + 1.2)
      mode = fg.npc ? "farm:npc" : "farm:crate"
      if (!vis || d > stand) move = this.navTo(fg.pos[0], fg.pos[1])
      else if (fg.npc && d < 40) {
        const L = d || 1
        move = this.safeDir((x - fg.pos[0]) / L, (y - fg.pos[1]) / L, 6)
      }
    } else if (wantLoot) {
      mode = "loot:" + wantLoot.kind
      const lp = wantLoot.pos
      move = this.navTo(lp[0], lp[1])
      const d = hyp(lp[0] - x, lp[1] - y)
      if (wantLoot.kind === "drop" && d < 3) move = [0, 0]
      boost = me.energy > 70 && d > 40
    } else {
      mode = "hold"
      if (P.farm && calm && this.t < 260) {
        const cellOf = (px: number, py: number) => Math.floor((px + 600) / 50) * 100 + Math.floor((py + 600) / 50)
        this.visited.add(cellOf(x, y))
        if (!this.explore || hyp(this.explore[0] - x, this.explore[1] - y) < 8 || this.t - this.exploreTime > 25) {
          let best: V2 | null = null
          let bs = 1e9
          for (let k = 0; k < 24; k++) {
            const a = this.rng() * TAU, r = 50 + this.rng() * 110
            const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r
            if (!inWant([px, py], -10) || !w || !w.walkable(px, py, 3)) continue
            const sc = r * 0.3 + (this.visited.has(cellOf(px, py)) ? 80 : 0) + hyp(px - zc.c[0], py - zc.c[1]) * 0.15
            if (sc < bs) {
              bs = sc
              best = [px, py]
            }
          }
          this.explore = best
          this.exploreTime = this.t
        }
        if (this.explore) {
          mode = "explore"
          move = this.navTo(this.explore[0], this.explore[1])
        }
      }
      if (mode === "explore") {
        // handled
      } else if (dZone > zc.r * 0.45) {
        move = this.navTo(zc.c[0], zc.c[1])
      } else if (ghosts.length || this.t - this.lastHurt < 5) {
        const th = ghosts[0]
        if (th) {
          if (!this.coverPt || this.t - this.coverTime > 1.5) {
            this.coverPt = this.findCover([th], zc)
            this.coverTime = this.t
          }
          if (this.coverPt) move = this.navTo(this.coverPt[0], this.coverPt[1])
        }
      } else {
        // wander slowly (silent below step speed)
        move = [0, 0]
      }
    }

    // apply dodge
    if (dodge[0] || dodge[1]) {
      move = [move[0] + dodge[0], move[1] + dodge[1]]
      boost = me.energy > 15
    }
    let ml = hyp(move[0], move[1])
    if (ml > 1) move = [move[0] / ml, move[1] / ml]
    ml = Math.min(1, ml)

    // ---- stuck detection ----
    this.posHist.push({ t: this.t, x, y, cmd: ml })
    while (this.posHist.length && this.t - this.posHist[0].t > 1.6) this.posHist.shift()
    if (this.t < this.unstickUntil) {
      move = this.unstickDir
      jump = me.grounded
      boost = true
    } else if (this.posHist.length > 10 && ml > 0.5) {
      const h0 = this.posHist[0]
      const allCmd = this.posHist.every((h) => h.cmd > 0.5)
      if (allCmd && hyp(x - h0.x, y - h0.y) < 2.0 && this.t - h0.t > 1.3) {
        // stuck: hop and try a perpendicular-ish direction
        const a = Math.atan2(move[1], move[0]) + (this.rng() < 0.5 ? 1 : -1) * (0.6 + this.rng() * 1.2)
        this.unstickDir = [Math.cos(a), Math.sin(a)]
        this.unstickUntil = this.t + 0.7
        this.path = []
        this.posHist = []
        jump = me.grounded
        boost = true
      }
    }
    // landed on a roof/raised spot: just keep going; jets when airborne in unstick handled above
    if (!me.grounded && this.t >= this.unstickUntil && mode !== "zone") boost = boost && me.energy > 40

    if (ml > 0.1) this.lastMoveDir = [move[0], move[1]]
    if (P.hide && !zoneUrgent && (mode === "hold" || mode.startsWith("loot")) && !(this.t < this.unstickUntil)) {
      const L = hyp(move[0], move[1])
      if (L > 0.42) move = [(move[0] / L) * 0.42, (move[1] / L) * 0.42] // below step-sound speed
      boost = false
    }
    act.move = [Math.round(move[0] * 1000) / 1000, Math.round(move[1] * 1000) / 1000]
    act.boost = boost
    act.jump = jump
    aimPitch = clamp(aimPitch, cfg.mech.min_pitch ?? -0.7, cfg.mech.max_pitch ?? 1.3)
    act.aim = [wrap(aimYaw), aimPitch]
    this.lastAimCmd = [aimYaw, aimPitch]
    act.fire = fire

    // ---- pickups: take if in range ----
    const reach = cfg.loot.pickup_radius ?? 4
    for (const p of obs.pickups) {
      if (hyp(p.pos[0] - x, p.pos[1] - y) > reach - 0.3 || Math.abs(p.pos[2] - z) > 3.8) continue
      if ((this.takeFail.get(p.id) ?? -99) > this.t - 1.5) continue
      const dec = this.pickupDecision(p.kind, wps, laserSlot)
      if (dec) {
        act.take = p.id
        if (dec.drop != null) act.drop = dec.drop
        break
      }
    }

    draw.label(`${mode} hp${Math.round(me.hp)} e${Math.round(me.energy)} ${target ? "T" + target.id + (tVis ? "v" : "") : ""}`)
    return act
  }

  /** Peek-and-hide: pick a firing spot next to cover; duck behind it while weapons recover. */
  peekFight(target: Track, pref: number, wps: any[], gunSlot: number, laserSlot: number, zc: { c: V2; r: number }): V2 | null {
    const w = this.world
    if (!w) return null
    const [x, y] = this.me.pos
    const tcz = this.centerZ(target)
    const tez = target.pos[2] + 8 * this.scale(target.cubes)
    const needNew = !this.peekSpot || this.peekFor !== target.id || this.t - this.peekTime > 1.2 ||
      hyp(this.peekSpot[0] - x, this.peekSpot[1] - y) > 30
    if (needNew && !this.over(10)) {
      this.peekTime = this.t
      this.peekFor = target.id
      const cand: { p: V2; vis: boolean }[] = []
      for (const R of [0, 4, 8, 12, 17, 23, 30]) {
        const n = R === 0 ? 1 : Math.round(R * 0.9) + 6
        for (let k = 0; k < n; k++) {
          const a = (k / n) * TAU
          const px = x + Math.cos(a) * R, py = y + Math.sin(a) * R
          if (!w.walkable(px, py, 2.9)) continue
          const gz = w.groundAt(px, py)
          const vis = w.los(px, py, gz + 7, target.pos[0], target.pos[1], tcz) && w.los(target.pos[0], target.pos[1], tez, px, py, gz + 6)
          cand.push({ p: [px, py], vis })
        }
      }
      let best: { peek: V2; hide: V2 } | null = null
      let bs = 1e9
      for (const c of cand) {
        if (!c.vis) continue
        if (this.over(16)) break
        const dt = hyp(c.p[0] - target.pos[0], c.p[1] - target.pos[1])
        if (dt < 25) continue
        let hide: V2 | null = null
        let hd = 1e9
        for (const h of cand) {
          if (h.vis) continue
          const d = hyp(h.p[0] - c.p[0], h.p[1] - c.p[1])
          if (d > 10 || d >= hd) continue
          // hidden spot must not be closer to the target than the peek spot by much
          if (hyp(h.p[0] - target.pos[0], h.p[1] - target.pos[1]) < dt - 6) continue
          if (!w.walkLine(c.p[0], c.p[1], h.p[0], h.p[1], 2.6)) continue
          hd = d
          hide = h.p
        }
        if (!hide) continue
        const dz = hyp(c.p[0] - zc.c[0], c.p[1] - zc.c[1])
        const s = hyp(c.p[0] - x, c.p[1] - y) * 1.2 + Math.abs(dt - pref) * 0.35 + hd * 1.5 + (dz > zc.r ? (dz - zc.r) * 2 : 0)
        if (s < bs) {
          bs = s
          best = { peek: c.p, hide }
        }
      }
      if (!best) {
        this.peekSpot = null
        this.hideSpot = null
        return null
      }
      this.peekSpot = best.peek
      this.hideSpot = best.hide
    }
    if (!this.peekSpot || !this.hideSpot) return null
    // decide phase
    const gun = gunSlot >= 0 ? wps[gunSlot] : null
    const laser = laserSlot >= 0 ? wps[laserSlot] : null
    const gunReady = gun && (gun.reload ?? 0) <= 0.3 && (gun.ammo ?? 0) > 0
    const laserReady = laser && laser.cooldown <= 0.25
    const laserCharged = laser && (laser.charge ?? 0) >= laser.stats.charge * 0.9
    const others = wps.some((wp, i) => wp && i !== gunSlot && i !== laserSlot && wp.cooldown <= 0.3)
    const hpFrac = this.me.hp / this.me.max_hp
    // enemy laser charging at us: hide unless we are about to fire a charged laser
    const brg = Math.atan2(this.me.pos[1] - target.pos[1], this.me.pos[0] - target.pos[0])
    const enemyThreat = target.charging && Math.abs(wrap(target.aim[0] - brg)) < 0.25
    let wantPeek = !!(gunReady || laserCharged || (laserReady && !laser) || others)
    if (laser && !gunReady && laserReady && !laserCharged) wantPeek = false // charge behind cover first
    if (enemyThreat && !laserCharged && hpFrac < 0.85) wantPeek = false
    if (target.hp < 250 && (gunReady || laserCharged)) wantPeek = true
    this.hiding = !wantPeek
    const goal = wantPeek ? this.peekSpot : this.hideSpot
    const d = hyp(goal[0] - x, goal[1] - y)
    if (d < 1.2) {
      // jiggle at the spot to stay a harder target
      if (wantPeek) return this.safeDir(Math.cos(this.t * 3.1) * 0.6, Math.sin(this.t * 3.1) * 0.6, 3)
      return [0, 0]
    }
    if (d < 40 && w.walkLine(x, y, goal[0], goal[1], 2.5)) return [(goal[0] - x) / d, (goal[1] - y) / d]
    return this.navTo(goal[0], goal[1])
  }

  pickupDecision(kind: string, wps: any[], laserSlot: number): { drop?: number } | null {
    if (wps.some((w) => w && w.kind === kind)) return null
    const empty = wps.findIndex((w) => !w)
    if (empty >= 0) return {}
    // both full: replace the least valuable if clearly better
    let worst = -1
    let wv = 1e9
    wps.forEach((w, i) => {
      if (!w) return
      if (w.kind === "laser" && (w.charge ?? 0) > 0) return
      const v = WEAPON_VALUE[w.kind] ?? 1
      if (v < wv) {
        wv = v
        worst = i
      }
    })
    if (worst >= 0 && (WEAPON_VALUE[kind] ?? 1) > wv + 0.3) return { drop: worst }
    return null
  }

  chooseLoot(obs: Observation, inWant: (p: number[], s?: number) => boolean, threatened: boolean): { kind: string; id: number; pos: number[] } | null {
    const me = obs.self
    const [x, y] = me.pos
    let best: { kind: string; id: number; pos: number[] } | null = null
    let bs = 1e9
    const consider = (kind: string, id: number, pos: number[], value: number, maxD: number) => {
      const d = hyp(pos[0] - x, pos[1] - y)
      if (d > maxD) return
      if (!inWant(pos, 15)) return
      if (Math.abs(pos[2] - (this.world ? this.world.groundAt(pos[0], pos[1]) : pos[2])) > 2.5) return // on a roof
      const s = d - value
      if (s < bs) {
        bs = s
        best = { kind, id, pos }
      }
    }
    for (const c of obs.cubes) consider("cube", c.id, c.pos, 60, threatened ? 25 : 160)
    for (const p of obs.pickups) {
      if ((this.takeFail.get(p.id) ?? -99) > this.t - 6) continue
      const dec = this.pickupDecision(p.kind, me.weapons as any[], -1)
      if (!dec) continue
      consider("pickup", p.id, p.pos, p.kind === "laser" ? 90 : 60, threatened ? 30 : 180)
    }
    // supply drops
    if (!threatened && me.hp / me.max_hp > 0.4) {
      for (const d of obs.drops) {
        if (d.holder != null && d.holder !== me.id) continue
        const dist = hyp(d.pos[0] - x, d.pos[1] - y)
        const travel = dist / (me.stats.walk_speed ?? 11.7)
        if (d.lands_in > travel + 8) continue
        // stand at the drop centre once landed; else approach
        consider("drop", d.id, d.pos, 120, 260)
      }
    }
    return best
  }

  mortarSolve(stats: any, st: { pos: number[]; vel: number[]; cz: number }, launchZ: number): V2 | null {
    const v = stats.speed, g = stats.gravity
    const [x, y] = this.me.pos
    let tx = st.pos[0], ty = st.pos[1]
    const tz = st.pos[2] + 0.5
    let sol: V2 | null = null
    for (let it = 0; it < 3; it++) {
      const d = hyp(tx - x, ty - y)
      const h = tz - launchZ
      const disc = v ** 4 - g * (g * d * d + 2 * h * v * v)
      if (disc < 0 || d < 1) return null
      const low = Math.atan((v * v - Math.sqrt(disc)) / (g * d))
      const high = Math.atan((v * v + Math.sqrt(disc)) / (g * d))
      let th = low
      // use the high arc if the low one is blocked
      const yaw = Math.atan2(ty - y, tx - x)
      const peakX = x + Math.cos(yaw) * d * 0.5, peakY = y + Math.sin(yaw) * d * 0.5
      const peakZ = launchZ + Math.tan(low) * d * 0.5 - (g * (d * 0.5) ** 2) / (2 * v * v * Math.cos(low) ** 2)
      if (!this.los(this.me.pos, launchZ, [peakX, peakY], peakZ) || !this.los([peakX, peakY], peakZ, st.pos, tz + 1)) th = high
      if (th > 1.25) th = low
      const ft = d / (v * Math.cos(th))
      tx = st.pos[0] + st.vel[0] * ft
      ty = st.pos[1] + st.vel[1] * ft
      sol = [Math.atan2(ty - y, tx - x), th]
    }
    return sol
  }
}


