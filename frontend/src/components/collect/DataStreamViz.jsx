import { useRef, useEffect } from 'react'

// ── Variable pool with category ────────────────────────────────────────────────
const VARS = [
  // 0 – Motion  (cyan)
  { l: 'Speed',        c: 0 }, { l: 'LatAccel',      c: 0 }, { l: 'LonAccel',    c: 0 },
  { l: 'VertAccel',    c: 0 }, { l: 'YawRate',        c: 0 }, { l: 'SteerAngle',  c: 0 },
  { l: 'VelX',         c: 0 }, { l: 'VelY',           c: 0 }, { l: 'Yaw',         c: 0 },
  { l: 'Pitch',        c: 0 }, { l: 'Roll',           c: 0 },
  // 1 – Engine  (orange)
  { l: 'RPM',          c: 1 }, { l: 'Gear',           c: 1 }, { l: 'Throttle',    c: 1 },
  { l: 'Brake',        c: 1 }, { l: 'Clutch',         c: 1 }, { l: 'FuelLevel',   c: 1 },
  { l: 'FuelUse/hr',   c: 1 }, { l: 'OilTemp',        c: 1 }, { l: 'WaterTemp',   c: 1 },
  { l: 'Manifold',     c: 1 }, { l: 'OilPress',       c: 1 },
  // 2 – Lap / Race  (green)
  { l: 'LapDist',      c: 2 }, { l: 'LapTime',        c: 2 }, { l: 'Lap',         c: 2 },
  { l: 'LapDistPct',   c: 2 }, { l: 'Position',       c: 2 }, { l: 'Incidents',   c: 2 },
  { l: 'SessionTime',  c: 2 }, { l: 'LapsLeft',       c: 2 }, { l: 'RaceTime',    c: 2 },
  // 3 – Tyres / Temps  (violet)
  { l: 'LF Temp',      c: 3 }, { l: 'RF Temp',        c: 3 }, { l: 'LR Temp',     c: 3 },
  { l: 'RR Temp',      c: 3 }, { l: 'TrackTemp',      c: 3 }, { l: 'AirTemp',     c: 3 },
  { l: 'LF Press',     c: 3 }, { l: 'RF Press',       c: 3 }, { l: 'LR Press',    c: 3 },
  { l: 'RR Press',     c: 3 }, { l: 'LF Wear',        c: 3 }, { l: 'RF Wear',     c: 3 },
  // 4 – Session / Meta  (yellow)
  { l: 'CarIdx',       c: 4 }, { l: 'SessionFlags',   c: 4 }, { l: 'CamCar',      c: 4 },
  { l: 'SessionState', c: 4 }, { l: 'BrakeBias',      c: 4 }, { l: 'RadioTx',     c: 4 },
  { l: 'ShiftInd',     c: 4 }, { l: 'dcABS',          c: 4 },
]

// Category RGB triples — bright palette, alpha controls intensity naturally
const CAT_RGB = [
  [34,  211, 238],  // 0 – Motion    cyan
  [251, 146,  60],  // 1 – Engine    orange
  [74,  222, 128],  // 2 – Lap/Race  green
  [192, 132, 252],  // 3 – Tyres     violet
  [250, 204,  21],  // 4 – Session   yellow
]
const CAT_NAMES = ['Motion', 'Engine', 'Lap/Race', 'Tyres', 'Session']

function rgba(cat, alpha) {
  const [r, g, b] = CAT_RGB[cat]
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`
}
function rand(a, b)  { return a + Math.random() * (b - a) }
function pick(arr)   { return arr[Math.floor(Math.random() * arr.length)] }

// ── Oscilloscope wave definitions ──────────────────────────────────────────────
const WAVE_DEFS = [
  { cat: 0, freq: 2.5, amp: 1.00 },  // Speed-like — fast
  { cat: 1, freq: 4.0, amp: 0.75 },  // RPM-like
  { cat: 2, freq: 0.8, amp: 0.55 },  // Lap — slow
  { cat: 3, freq: 1.4, amp: 0.65 },  // Temp — medium
  { cat: 4, freq: 0.5, amp: 0.45 },  // Session — very slow
]

// ── Factories ──────────────────────────────────────────────────────────────────
function makeParticle(W, H, bright) {
  const edge = Math.floor(Math.random() * 4)
  let x, y
  if      (edge === 0) { x = rand(0, W);      y = rand(-30, -5)  }  // top
  else if (edge === 1) { x = rand(W + 5, W + 30); y = rand(0, H) }  // right
  else if (edge === 2) { x = rand(0, W);      y = rand(H + 5, H + 30) }  // bottom
  else                 { x = rand(-30, -5);   y = rand(0, H)     }  // left

  const speed  = bright ? rand(0.25, 0.9) : rand(0.04, 0.18)
  const toX    = W * rand(0.2, 0.8)
  const toY    = H * rand(0.2, 0.8)
  const angle  = Math.atan2(toY - y, toX - x) + rand(-0.6, 0.6)

  return {
    x, y,
    vx:          Math.cos(angle) * speed,
    vy:          Math.sin(angle) * speed,
    varDef:      pick(VARS),
    alpha:       0,
    maxAlpha:    bright ? rand(0.65, 1.0) : rand(0.10, 0.28),
    phase:       rand(0, Math.PI * 2),
    phaseSpeed:  rand(0.008, 0.035),
    life:        0,
    maxLife:     bright ? (200 + (Math.random() * 350 | 0)) : (500 + (Math.random() * 700 | 0)),
    trail:       [],
  }
}

function makePulse(cx, cy, W, H, large = false) {
  return {
    x:     cx,
    y:     cy,
    r:     0,
    maxR:  Math.min(W, H) * rand(large ? 0.35 : 0.18, large ? 0.6 : 0.38),
    alpha: large ? 0.9 : 0.65,
    speed: large ? 3.2 : 2.0,
  }
}

// ── Draw helpers ───────────────────────────────────────────────────────────────
function drawBackground(ctx, W, H) {
  ctx.fillStyle = '#07070c'
  ctx.fillRect(0, 0, W, H)

  // Dot grid
  ctx.fillStyle = 'rgba(255,255,255,0.030)'
  for (let gx = 25; gx < W; gx += 30) {
    for (let gy = 20; gy < H; gy += 30) {
      ctx.beginPath()
      ctx.arc(gx, gy, 0.75, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Radial vignette
  const grad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.8)
  grad.addColorStop(0, 'rgba(0,0,0,0)')
  grad.addColorStop(1, 'rgba(0,0,0,0.55)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)
}

function drawWaves(ctx, W, H, isCollecting, frame) {
  const baseY   = H * 0.775
  const gap     = H * 0.042
  const ampBase = isCollecting ? 12 : 2.5
  const aBase   = isCollecting ? 0.32 : 0.055

  for (let wi = 0; wi < WAVE_DEFS.length; wi++) {
    const { cat, freq, amp } = WAVE_DEFS[wi]
    const cy = baseY + (wi - 2) * gap
    const A  = ampBase * amp
    const a  = aBase * (1 - wi * 0.07)

    ctx.strokeStyle = rgba(cat, a)
    ctx.lineWidth   = 1
    ctx.beginPath()

    for (let x = 0; x <= W; x += 3) {
      const t = (x / W * 6 + frame * freq * 0.004) * Math.PI * 2
      const y = cy + Math.sin(t) * A + Math.sin(t * 1.9 + wi * 1.1) * A * 0.28
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
}

function drawPulses(ctx, pulses) {
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i]
    p.r    += p.speed
    p.alpha *= 0.965
    if (p.alpha < 0.012 || p.r > p.maxR) { pulses.splice(i, 1); continue }

    ctx.strokeStyle = `rgba(34,211,238,${(p.alpha * 0.55).toFixed(3)})`
    ctx.lineWidth   = 1.5
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.stroke()

    if (p.r > 18) {
      ctx.strokeStyle = `rgba(34,211,238,${(p.alpha * 0.2).toFixed(3)})`
      ctx.lineWidth   = 0.8
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r - 14, 0, Math.PI * 2); ctx.stroke()
    }
  }
}

function drawConnections(ctx, particles, isCollecting) {
  const maxDist   = isCollecting ? 115 : 65
  const maxDistSq = maxDist * maxDist
  const cap       = Math.min(particles.length, 100)

  for (let i = 0; i < cap; i++) {
    let conns = 0
    for (let j = i + 1; j < cap && conns < 3; j++) {
      const dx = particles[i].x - particles[j].x
      const dy = particles[i].y - particles[j].y
      if (dx * dx + dy * dy < maxDistSq) {
        conns++
        const t = 1 - Math.sqrt(dx * dx + dy * dy) / maxDist
        const a = Math.min(particles[i].alpha, particles[j].alpha) * t * (isCollecting ? 0.28 : 0.07)
        ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`
        ctx.lineWidth   = 0.5
        ctx.beginPath()
        ctx.moveTo(particles[i].x, particles[i].y)
        ctx.lineTo(particles[j].x, particles[j].y)
        ctx.stroke()
      }
    }
  }
}

function drawParticle(ctx, p, isCollecting) {
  const { varDef: { l, c }, trail, x, y, alpha } = p

  // Trail
  if (trail.length > 1) {
    for (let t = 1; t < trail.length; t++) {
      ctx.strokeStyle = rgba(c, (t / trail.length) * alpha * 0.22)
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(trail[t - 1].x, trail[t - 1].y)
      ctx.lineTo(trail[t].x,     trail[t].y)
      ctx.stroke()
    }
  }

  // Multi-ring glow (no radialGradient — cheaper, still looks great)
  if (alpha > 0.07) {
    ctx.fillStyle = rgba(c, alpha * 0.07)
    ctx.beginPath(); ctx.arc(x, y, isCollecting ? 16 : 7, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = rgba(c, alpha * 0.16)
    ctx.beginPath(); ctx.arc(x, y, isCollecting ? 7  : 3, 0, Math.PI * 2); ctx.fill()
  }

  // Core dot
  const r = isCollecting ? 2.5 : 1.5
  ctx.fillStyle = rgba(c, alpha)
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()

  // Label
  ctx.font      = `${isCollecting ? 9 : 7}px 'Courier New',monospace`
  ctx.fillStyle = rgba(c, alpha * 0.82)
  ctx.fillText(l, x + r + 2.5, y + 3.5)
}

function drawHUD(ctx, W, H, isCollecting, tickCount, hz, label) {
  ctx.save()
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'bottom'

  if (isCollecting) {
    // Large ghosted tick counter
    ctx.font      = `bold 88px 'Courier New',monospace`
    ctx.fillStyle = 'rgba(34,211,238,0.042)'
    ctx.textBaseline = 'middle'
    ctx.fillText(tickCount.toLocaleString(), W / 2, H / 2)
    ctx.textBaseline = 'bottom'

    // Status bar
    ctx.font      = '11px "Courier New",monospace'
    ctx.fillStyle = 'rgba(34,211,238,0.9)'
    const status  = `● REC  ${tickCount.toLocaleString()} ticks  ·  ${hz} Hz${label ? `  ·  "${label}"` : ''}`
    ctx.fillText(status, W / 2, H - 10)

    // Category legend  (bottom-right)
    ctx.font      = '9px "Courier New",monospace'
    ctx.textAlign = 'right'
    CAT_NAMES.forEach((name, i) => {
      ctx.fillStyle = rgba(i, 0.6)
      ctx.fillText(`■ ${name}`, W - 12, H - 86 + i * 15)
    })
  } else {
    ctx.font      = '11px "Courier New",monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.09)'
    ctx.fillText('CONNECT IRACING  ·  PRESS RECORD', W / 2, H - 10)
  }

  ctx.restore()
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function DataStreamViz({ isCollecting = false, tickCount = 0, hz = 4, label = '' }) {
  const canvasRef = useRef(null)
  const propsRef  = useRef({ isCollecting, tickCount, hz, label })
  const stateRef  = useRef({
    particles:      [],
    pulses:         [],
    frame:          0,
    lastTickCount:  -1,
    wasCollecting:  false,
  })

  // Keep latest props accessible inside rAF without restarting the loop
  propsRef.current = { isCollecting, tickCount, hz, label }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx   = canvas.getContext('2d')
    const state = stateRef.current
    const IDLE_MAX = 32
    const LIVE_MAX = 155

    let animId = null

    const resize = () => {
      const dpr    = window.devicePixelRatio || 1
      canvas.width  = canvas.offsetWidth  * dpr
      canvas.height = canvas.offsetHeight * dpr
    }

    const tick = () => {
      const { isCollecting, tickCount, hz, label } = propsRef.current
      const dpr = window.devicePixelRatio || 1
      const W   = canvas.offsetWidth
      const H   = canvas.offsetHeight
      const cx  = W / 2
      const cy  = H / 2

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      // ── Transition: idle → collecting (big bang) ──────────────────────
      if (isCollecting && !state.wasCollecting) {
        for (let i = 0; i < 55 && state.particles.length < LIVE_MAX; i++) {
          state.particles.push(makeParticle(W, H, true))
        }
        state.pulses.push(makePulse(cx, cy, W, H, true))
        state.pulses.push(makePulse(cx, cy, W, H, true))
        state.lastTickCount = tickCount
      }
      state.wasCollecting = isCollecting

      // ── New tick burst ────────────────────────────────────────────────
      if (isCollecting && tickCount !== state.lastTickCount) {
        const newTicks = Math.max(tickCount - state.lastTickCount, 1)
        const burst    = Math.min(newTicks * 3, 14)
        for (let i = 0; i < burst && state.particles.length < LIVE_MAX; i++) {
          state.particles.push(makeParticle(W, H, true))
        }
        state.pulses.push(makePulse(cx, cy, W, H, false))
        state.lastTickCount = tickCount
      }

      // ── Passive spawn ─────────────────────────────────────────────────
      if (state.frame % (isCollecting ? 12 : 90) === 0) {
        const maxP = isCollecting ? LIVE_MAX : IDLE_MAX
        if (state.particles.length < maxP) {
          state.particles.push(makeParticle(W, H, isCollecting))
        }
      }

      state.frame++

      // ── Render ────────────────────────────────────────────────────────
      drawBackground(ctx, W, H)
      drawWaves(ctx, W, H, isCollecting, state.frame)
      drawPulses(ctx, state.pulses)
      drawConnections(ctx, state.particles, isCollecting)

      state.particles = state.particles.filter(p => {
        p.life++
        p.x += p.vx
        p.y += p.vy
        // Soft sine wobble
        p.vx += Math.sin(p.phase + p.life * p.phaseSpeed) * 0.004
        p.vy += Math.cos(p.phase + p.life * p.phaseSpeed) * 0.004
        p.vx *= 0.999
        p.vy *= 0.999

        // Alpha lifecycle — fade in (first 8%), full, fade out (last 28%)
        const r = p.life / p.maxLife
        p.alpha = r < 0.08
          ? (r / 0.08)         * p.maxAlpha
          : r > 0.72
            ? ((1 - r) / 0.28) * p.maxAlpha
            : p.maxAlpha

        if (p.life >= p.maxLife || p.x < -100 || p.x > W + 100 || p.y < -100 || p.y > H + 100)
          return false

        p.trail.push({ x: p.x, y: p.y })
        if (p.trail.length > 10) p.trail.shift()

        drawParticle(ctx, p, isCollecting)
        return true
      })

      drawHUD(ctx, W, H, isCollecting, tickCount, hz, label)

      animId = requestAnimationFrame(tick)
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    animId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(animId)
      ro.disconnect()
    }
  }, [])   // run once — live values read via propsRef inside rAF

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full block"
      style={{ background: '#07070c' }}
    />
  )
}
