import { useState, useEffect, useRef, useCallback } from 'react'
import { BarChart3 } from 'lucide-react'
import { EVENT_CONFIG, severityColorCard } from './analysisConstants'

// ── Animation modes ───────────────────────────────────────────────────────────

const MODES = [
  'popcorn', 'rain', 'cannon', 'fireworks', 'drift',
  'vortex', 'ricochet', 'spiral', 'comet', 'slingshot',
]

function pickModeNotEqual(previous) {
  if (MODES.length <= 1) return MODES[0] || 'popcorn'
  const options = MODES.filter(m => m !== previous)
  return options[Math.floor(Math.random() * options.length)]
}

/**
 * Returns spawn + physics config for the given mode.
 * All positions are in CSS pixel space: +x = right, +y = down.
 * Gravity is in px/s² (positive = downward).
 */
function getModeConfig(mode) {
  switch (mode) {
    case 'popcorn': return {
      // Burst upward from centre in a wide fan, then arc back down
      spawnAt: (w, h) => ({
        x: w * 0.5 + (Math.random() - 0.5) * w * 0.1,
        y: h * 0.52 + (Math.random() - 0.5) * h * 0.06,
      }),
      initV: () => {
        // 10°–170° above horizontal — full upper fan
        const a = (10 + Math.random() * 160) * (Math.PI / 180)
        const s = 170 + Math.random() * 190
        return { vx: Math.cos(a) * s, vy: -Math.sin(a) * s }
      },
      gravity: 245,
      dampX: 0.996,
      dampY: 1.0,
      lifetime: 2800,
      spawnCount: 2,
    }

    case 'rain': return {
      // Drop in from the top at scattered positions
      spawnAt: (w, _h) => ({ x: w * 0.07 + Math.random() * w * 0.86, y: -50 }),
      initV: () => ({ vx: (Math.random() - 0.5) * 75, vy: 145 + Math.random() * 120 }),
      gravity: 95,
      dampX: 0.998,
      dampY: 1.0,
      lifetime: 3600,
      spawnCount: 3,
    }

    case 'cannon': return {
      // Fire from bottom-left like a cannon at varied trajectories
      spawnAt: (_w, h) => ({ x: 14, y: h - 18 }),
      initV: () => {
        const a = (28 + Math.random() * 38) * (Math.PI / 180) // 28°–66° above H
        const s = 260 + Math.random() * 190
        return { vx: Math.cos(a) * s, vy: -Math.sin(a) * s }
      },
      gravity: 270,
      dampX: 0.998,
      dampY: 1.0,
      lifetime: 2700,
      spawnCount: 2,
    }

    case 'fireworks': return {
      // Burst from random interior points in all directions, low gravity so they spread
      spawnAt: (w, h) => ({
        x: w * 0.18 + Math.random() * w * 0.64,
        y: h * 0.14 + Math.random() * h * 0.46,
      }),
      initV: () => {
        const a = Math.random() * Math.PI * 2
        const s = 70 + Math.random() * 130
        return { vx: Math.cos(a) * s, vy: Math.sin(a) * s }
      },
      gravity: 22,
      dampX: 0.9,
      dampY: 0.9,
      lifetime: 3300,
      spawnCount: 3,
    }

    case 'drift': return {
      // Float in from the left at random heights, drifting gently rightward
      spawnAt: (_w, h) => ({ x: -30, y: h * 0.1 + Math.random() * h * 0.8 }),
      initV: () => ({ vx: 105 + Math.random() * 90, vy: (Math.random() - 0.5) * 65 }),
      gravity: 0,
      dampX: 0.997,
      dampY: 0.997,
      lifetime: 4000,
      spawnCount: 2,
    }

    case 'vortex': return {
      // Spawn around centre and whip cards around with strong tangential velocity
      spawnAt: (w, h) => ({
        x: w * 0.5 + (Math.random() - 0.5) * w * 0.25,
        y: h * 0.5 + (Math.random() - 0.5) * h * 0.2,
      }),
      initV: () => {
        const a = Math.random() * Math.PI * 2
        const s = 190 + Math.random() * 140
        return { vx: Math.cos(a) * s, vy: Math.sin(a) * s }
      },
      gravity: 28,
      dampX: 0.985,
      dampY: 0.985,
      lifetime: 3000,
      spawnCount: 3,
    }

    case 'ricochet': return {
      // Kick in diagonally from random edges
      spawnAt: (w, h) => {
        const edge = Math.floor(Math.random() * 4)
        if (edge === 0) return { x: -24, y: Math.random() * h }
        if (edge === 1) return { x: w + 24, y: Math.random() * h }
        if (edge === 2) return { x: Math.random() * w, y: -24 }
        return { x: Math.random() * w, y: h + 24 }
      },
      initV: () => {
        const a = Math.random() * Math.PI * 2
        const s = 210 + Math.random() * 180
        return { vx: Math.cos(a) * s, vy: Math.sin(a) * s }
      },
      gravity: 40,
      dampX: 0.994,
      dampY: 0.994,
      lifetime: 2400,
      spawnCount: 2,
    }

    case 'spiral': return {
      // Start near centre and fan out like a pinwheel
      spawnAt: (w, h) => ({
        x: w * 0.5 + (Math.random() - 0.5) * 16,
        y: h * 0.5 + (Math.random() - 0.5) * 16,
      }),
      initV: () => {
        const a = Math.random() * Math.PI * 2
        const s = 135 + Math.random() * 120
        return { vx: Math.cos(a) * s, vy: Math.sin(a) * s }
      },
      gravity: 14,
      dampX: 0.989,
      dampY: 0.989,
      lifetime: 3200,
      spawnCount: 3,
    }

    case 'comet': return {
      // Fast streaks crossing from upper-left toward lower-right
      spawnAt: (w, h) => ({
        x: -40,
        y: h * 0.02 + Math.random() * h * 0.35,
      }),
      initV: () => ({
        vx: 300 + Math.random() * 170,
        vy: 85 + Math.random() * 80,
      }),
      gravity: 22,
      dampX: 0.997,
      dampY: 0.997,
      lifetime: 2300,
      spawnCount: 2,
    }

    case 'slingshot': return {
      // Pull from lower-right and fling back across frame
      spawnAt: (w, h) => ({ x: w + 18, y: h - 20 - Math.random() * 60 }),
      initV: () => {
        const a = (155 + Math.random() * 22) * (Math.PI / 180)
        const s = 245 + Math.random() * 170
        return { vx: Math.cos(a) * s, vy: Math.sin(a) * s }
      },
      gravity: 180,
      dampX: 0.996,
      dampY: 0.998,
      lifetime: 2800,
      spawnCount: 2,
    }

    default: return getModeConfig('popcorn')
  }
}

const MAX_ACTIVE_PARTICLES = 40
let _uid = 0

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * EventParticleOverlay
 *
 * Replaces the old vertical event-feed list with a physics-based particle
 * system. Each time analysis starts, one of five animation modes is chosen
 * at random (popcorn / rain / cannon / fireworks / drift).  Incoming events
 * spawn a card-particle whose position, rotation and scale are driven by the
 * simulation until it fades out.
 *
 * @param {Object[]} feedEvents  - stream of newly discovered events
 * @param {boolean}  isAnalyzing - whether analysis is actively running
 */
export default function EventParticleOverlay({ feedEvents, isAnalyzing }) {
  const containerRef   = useRef(null)
  const modeRef        = useRef('popcorn')
  const lastModeRef    = useRef('popcorn')
  const isAnalRef      = useRef(isAnalyzing)
  const particlesRef   = useRef([])   // mutable physics state
  const rafRef         = useRef(null)
  const lastTsRef      = useRef(null)
  const isRunningRef   = useRef(false)
  const seenIdsRef     = useRef(new Set())
  const [snapshot, setSnapshot] = useState([])

  // Keep isAnalyzing readable from inside the RAF closure without recreating it
  useEffect(() => { isAnalRef.current = isAnalyzing }, [isAnalyzing])

  // Pick a new mode each time analysis starts; clear seen-ids on stop
  useEffect(() => {
    if (isAnalyzing) {
      const nextMode = pickModeNotEqual(lastModeRef.current)
      modeRef.current = nextMode
      lastModeRef.current = nextMode
    } else {
      seenIdsRef.current.clear()
    }
  }, [isAnalyzing])

  // ── Physics loop (stable, reads everything from refs) ─────────────────────
  const startLoop = useCallback(() => {
    if (isRunningRef.current) return
    isRunningRef.current = true
    lastTsRef.current    = null

    const tick = (timestamp) => {
      if (lastTsRef.current === null) lastTsRef.current = timestamp
      const dt = Math.min((timestamp - lastTsRef.current) / 1000, 0.05)
      lastTsRef.current = timestamp

      const { gravity, dampX, dampY } = getModeConfig(modeRef.current)

      particlesRef.current = particlesRef.current
        .map(p => {
          const age      = p.age + dt * 1000
          if (age >= p.maxAge) return null

          const progress = age / p.maxAge

          // Scale: spring to 1 over first 160 ms
          const scale = Math.min(1.0, age / 160)

          // Opacity: full → fade out in the last 40 %
          const opacity = progress < 0.6 ? 1.0 : 1.0 - (progress - 0.6) / 0.4

          // Velocity integration
          const vx = p.vx * (dampX ?? 0.997)
          const vy = p.vy * (dampY ?? 1.0) + (gravity ?? 0) * dt

          // Rotation decays with age so cards settle
          const rotSpeed = p.rotSpeed * (1 - progress * 0.65)

          return {
            ...p,
            age, scale, opacity,
            vx, vy,
            x: p.x + vx * dt,
            y: p.y + vy * dt,
            rot: p.rot + rotSpeed * dt,
          }
        })
        .filter(Boolean)

      setSnapshot([...particlesRef.current])

      if (particlesRef.current.length > 0 || isAnalRef.current) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        isRunningRef.current = false
        rafRef.current = null
      }
    }

    rafRef.current = requestAnimationFrame(tick)
  }, []) // intentionally stable — reads all state from refs

  // ── Spawn particles for new events ────────────────────────────────────────
  useEffect(() => {
    if (!feedEvents?.length) return
    const el = containerRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    if (!width || !height) return

    let spawned = 0
    for (const ev of feedEvents) {
      if (seenIdsRef.current.has(ev.id)) continue
      seenIdsRef.current.add(ev.id)

      // Evict oldest particle if at cap
      if (particlesRef.current.length >= MAX_ACTIVE_PARTICLES) {
        particlesRef.current.shift()
      }

      const cfg = getModeConfig(modeRef.current)
      const count = Math.max(1, cfg.spawnCount || 1)

      for (let i = 0; i < count; i += 1) {
        // Evict oldest particles until we are under the active cap.
        while (particlesRef.current.length >= MAX_ACTIVE_PARTICLES) {
          particlesRef.current.shift()
        }

        const { x, y } = cfg.spawnAt(width, height)
        const { vx, vy } = cfg.initV()

        particlesRef.current.push({
          id:       _uid++,
          x, y, vx, vy,
          rot:      (Math.random() - 0.5) * 20,
          rotSpeed: (Math.random() - 0.5) * 120,
          scale:    0,
          opacity:  1,
          age:      0,
          maxAge:   cfg.lifetime ?? 3000,
          ev,
        })
        spawned++
      }
    }

    if (spawned > 0) startLoop()
  }, [feedEvents, startLoop])

  // Ensure the loop runs while analysis is active (even if no particles yet)
  useEffect(() => {
    if (isAnalyzing) startLoop()
  }, [isAnalyzing, startLoop])

  // Cleanup on unmount
  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    isRunningRef.current = false
  }, [])

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none overflow-hidden">
      {snapshot.map(p => {
        const cfg  = EVENT_CONFIG[p.ev.type] || {}
        const Icon = cfg.icon || BarChart3
        const names = p.ev.driverNames || []

        return (
          <div
            key={p.id}
            className="absolute top-0 left-0"
            style={{
              transform: `translate(calc(${p.x.toFixed(1)}px - 50%), calc(${p.y.toFixed(1)}px - 50%)) rotate(${p.rot.toFixed(2)}deg) scale(${p.scale.toFixed(3)})`,
              opacity: p.opacity,
              willChange: 'transform, opacity',
            }}
          >
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/85 backdrop-blur-md border border-white/20 shadow-elevated whitespace-nowrap select-none">
              <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${cfg.bg || 'bg-white/10'}`}>
                <Icon size={13} className={cfg.color || 'text-white'} />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-white font-semibold text-xs leading-tight">{cfg.label || p.ev.type}</span>
                {names.length > 0 && (
                  <span className="text-white/60 text-xxs truncate max-w-[130px]">
                    {names.join(' · ')}
                  </span>
                )}
              </div>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-xxs shrink-0 ${severityColorCard(p.ev.severity)}`}>
                {p.ev.severity}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
