import { useState, useEffect, useRef } from 'react'
import {
  X, ListOrdered, Target, Shuffle, Sliders, Film, Camera,
  HelpCircle, ChevronRight, Info, Wand2, Users,
} from 'lucide-react'

/* ─────────────────────────────────────────────────────────────────────────
   Small static "demo" components — visual replicas of the actual controls,
   non-interactive, used as inline illustrations inside the guide text.
───────────────────────────────────────────────────────────────────────── */

function DemoSlider({ label, value, min, max, displayValue, accent = false }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="flex items-center gap-2 pb-3.5">
      <span className="text-xxs text-text-secondary shrink-0 flex items-center gap-1" style={{ minWidth: '7rem' }}>
        {label}
        <Info className="w-3 h-3 text-text-disabled shrink-0" />
      </span>
      <div className="flex-1 relative h-1 rounded-full bg-border">
        <div
          className={`absolute left-0 top-0 h-1 rounded-full ${accent ? 'bg-accent' : 'bg-accent/60'}`}
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute -top-1.5 w-3 h-3 rounded-full bg-accent border-2 border-bg-tertiary shadow"
          style={{ left: `calc(${pct}% - 6px)` }}
        />
      </div>
      <span className="text-xxs text-text-tertiary font-mono w-10 text-right">{displayValue ?? value}</span>
    </div>
  )
}

function DemoToggle({ label, on }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xxs text-text-secondary flex items-center gap-1" style={{ minWidth: '7rem' }}>
        {label}
        <Info className="w-3 h-3 text-text-disabled shrink-0" />
      </span>
      <div className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border
                       ${on ? 'bg-accent border-accent' : 'bg-bg-tertiary border-border'}`}>
        <span className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform
                          ${on ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </div>
      <span className="text-xxs font-mono text-text-tertiary">{on ? 'On' : 'Off'}</span>
    </div>
  )
}

function DemoEventRow({ label, color, value = 70 }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-3 h-3 rounded-full shrink-0 border border-white/20" style={{ backgroundColor: color }} />
      <span className="text-xxs w-16 truncate text-text-secondary">{label}</span>
      <div className="flex-1 relative h-1 rounded-full bg-border">
        <div className="absolute left-0 top-0 h-1 rounded-full" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
      <span className="text-xxs text-text-tertiary font-mono w-7 text-right">{value}</span>
    </div>
  )
}

function DemoMixRow({ label }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xxs w-16 truncate text-text-secondary">{label}</span>
      <div className="w-12 text-xxs bg-surface-2 border border-border-subtle rounded px-1 py-0.5 font-mono text-text-tertiary text-center">15</div>
      <div className="w-12 text-xxs bg-surface-2 border border-accent/30 rounded px-1 py-0.5 font-mono text-text-tertiary text-center">20</div>
      <div className="w-12 text-xxs bg-surface-2 border border-border-subtle rounded px-1 py-0.5 font-mono text-text-tertiary text-center">35</div>
    </div>
  )
}

function DemoSelect({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xxs text-text-secondary cursor-help">{label}</span>
      <div className="text-xxs bg-surface-2 border border-border-subtle rounded px-1.5 py-0.5 text-text-secondary">
        {value}
      </div>
    </div>
  )
}

function GuideBox({ children }) {
  return (
    <div className="bg-bg-primary border border-border rounded-xl p-3 space-y-1.5">
      {children}
    </div>
  )
}

function Note({ children }) {
  return (
    <div className="flex gap-2 p-2.5 rounded-lg bg-accent/5 border border-accent/20">
      <Info className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
      <p className="text-xs text-text-secondary leading-relaxed">{children}</p>
    </div>
  )
}

function SectionTitle({ children }) {
  return <h3 className="text-sm font-semibold text-text-primary mt-1">{children}</h3>
}

function Body({ children }) {
  return <p className="text-xs text-text-secondary leading-relaxed">{children}</p>
}

function SubLabel({ children }) {
  return <p className="text-xxs font-medium text-text-tertiary uppercase tracking-wider mt-3 mb-1">{children}</p>
}

/* ─────────────────────────────────────────────────────────────────────────
   Section content definitions
───────────────────────────────────────────────────────────────────────── */

const SECTIONS = [
  {
    id: 'overview',
    icon: HelpCircle,
    label: 'Overview',
    content: (
      <div className="space-y-4">
        <SectionTitle>Editing Controls — Overview</SectionTitle>
        <Body>
          The editing controls panel is the heart of highlight creation. It gives you fine-grained control
          over which events are selected, how they are scored, how much variety the selector enforces,
          how clips are padded, and how cameras are chosen.
        </Body>
        <Body>
          All changes take effect immediately in the event list on the right — you see score updates and
          selection changes in real time without needing to re-run analysis. When you click
          <strong className="text-text-primary"> Generate Script</strong>, the server performs the
          authoritative final selection using the same algorithm.
        </Body>
        <div className="grid grid-cols-1 gap-2 pt-1">
          {[
            { icon: ListOrdered, label: 'Event Priorities',  color: 'text-accent', desc: 'Weight sliders that control how much each event type is valued relative to others.' },
            { icon: Target,       label: 'Minimum Score',    color: 'text-event-fastest', desc: 'Filter out low-severity events before selection even begins.' },
            { icon: Shuffle,      label: 'Mix & Diversity',  color: 'text-event-overtake', desc: 'Prevent any single event type from dominating. Set floors, caps, and decay.' },
            { icon: Users,        label: 'Driver Coverage',  color: 'text-event-incident', desc: 'Softly broaden field coverage without overriding strong race-story events.' },
            { icon: Sliders,      label: 'Direction Tuning', color: 'text-event-battle', desc: 'Race-context boosts, driver focus, PiP behaviour, and phase bonuses.' },
            { icon: Film,         label: 'Clip Padding',     color: 'text-event-pit', desc: 'How many seconds before and after each event to include in the clip.' },
            { icon: Camera,       label: 'Camera Selection', color: 'text-event-leader', desc: 'Which camera groups to use and how to weight them during playback.' },
          ].map(({ icon: Icon, label, color, desc }) => (
            <div key={label} className="flex gap-3 p-2.5 rounded-xl bg-bg-primary border border-border">
              <Icon size={14} className={`${color} shrink-0 mt-0.5`} />
              <div>
                <p className="text-xs font-medium text-text-primary">{label}</p>
                <p className="text-xxs text-text-tertiary mt-0.5 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
        <Note>
          Changes to scoring parameters update the in-browser preview instantly.
          Click <strong>Generate Script</strong> to run the full server-side algorithm
          and lock in the final ordered timeline for capture.
        </Note>
      </div>
    ),
  },

  {
    id: 'priorities',
    icon: ListOrdered,
    label: 'Event Priorities',
    content: (
      <div className="space-y-4">
        <SectionTitle>Event Priorities</SectionTitle>
        <Body>
          Each event type gets a weight from 0–100. The weight acts as a multiplier on the
          raw normalised score before selection — a type at 100 will always outscore the same
          event at 50, all else being equal.
        </Body>

        <SubLabel>Example priority rows</SubLabel>
        <GuideBox>
          <DemoEventRow label="Battle"       color="#f59e0b" value={70} />
          <DemoEventRow label="Overtake"     color="#10b981" value={75} />
          <DemoEventRow label="Incident"     color="#ef4444" value={80} />
          <DemoEventRow label="Car Contact"  color="#f97316" value={50} />
          <DemoEventRow label="Leader Chg"   color="#8b5cf6" value={90} />
          <DemoEventRow label="Pit Stop"     color="#06b6d4" value={20} />
        </GuideBox>

        <Body>
          The <strong className="text-text-primary">coloured dot</strong> on the left is a quick
          toggle — click it to zero out (disable) the type or restore it to 50. The slider
          controls the exact value. All types share the same 0–100 scale.
        </Body>

        <SubLabel>Auto-balance</SubLabel>
        <div className="bg-bg-primary border border-border rounded-xl p-3">
          <div className="flex items-center gap-1.5 px-2 py-1.5 text-xxs font-medium text-accent bg-accent/10 rounded w-fit">
            <Wand2 className="w-3 h-3" />
            Auto-balance weights
          </div>
        </div>
        <Body>
          Auto-balance distributes weights evenly across all non-zero types. Useful as a
          reset point if you want an equal-chance starting position.
        </Body>

        <Note>
          Weights interact with <strong>Score Normalization</strong> (see Mix &amp; Diversity).
          In cross-type mode (default) the slider is an honest multiplier across types.
          In per-type mode each type is independently normalised first, making a 70 in
          "Battle" and 70 in "Pit Stop" contribute equally regardless of raw score differences.
        </Note>
      </div>
    ),
  },

  {
    id: 'minscore',
    icon: Target,
    label: 'Minimum Score',
    content: (
      <div className="space-y-4">
        <SectionTitle>Minimum Score</SectionTitle>
        <Body>
          Sets a hard severity floor. Any event whose raw severity is below this value is
          excluded from selection entirely — it will not appear in the highlight reel or
          in score calculations.
        </Body>

        <SubLabel>The slider</SubLabel>
        <GuideBox>
          <DemoSlider label="Min Severity" value={3} min={0} max={10} displayValue="3" accent />
        </GuideBox>

        <Body>
          Severity (1–10) is assigned by the event detectors based on how extreme the moment was —
          e.g. a high-contact incident gets 8–10, a gentle position swap gets 3–5.
          A value of 0 includes everything; a value of 6+ shows only the most dramatic moments.
        </Body>

        <Note>
          Raising this slider is the fastest way to shrink a bloated highlight reel.
          If your script is running too long, try 4–5 before touching target duration.
        </Note>
      </div>
    ),
  },

  {
    id: 'mixdiversity',
    icon: Shuffle,
    label: 'Mix & Diversity',
    content: (
      <div className="space-y-5">
        <SectionTitle>Mix &amp; Diversity</SectionTitle>
        <Body>
          The default score-greedy selector picks the globally highest-scoring events first,
          which can fill your entire reel with nothing but battles if they happen to score well.
          Mix &amp; Diversity prevents that by applying three complementary mechanisms:
        </Body>

        <div className="space-y-2">
          {[
            { label: 'Type Decay',      desc: 'Each successive event of the same type scores lower — like diminishing returns. The 3rd battle is worth less than the 1st.' },
            { label: 'Mix Floors',      desc: 'Soft minimum shares per type. If a type falls below its floor, a small score boost is applied to nudge it into selection.' },
            { label: 'Mix Caps',        desc: 'Hard maximum shares per type. Selection of a type stops the moment it hits its cap, no matter how high its score.' },
          ].map(({ label, desc }) => (
            <div key={label} className="flex gap-3 p-2.5 rounded-xl bg-bg-primary border border-border">
              <ChevronRight size={13} className="text-accent shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-text-primary">{label}</p>
                <p className="text-xxs text-text-tertiary mt-0.5 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Diversity Strength ── */}
        <SubLabel>Diversity Strength — master knob</SubLabel>
        <GuideBox>
          <DemoSlider label="Diversity Strength" value={70} min={0} max={100} displayValue="70" accent />
        </GuideBox>
        <Body>
          This is the master dial. <strong className="text-text-primary">0</strong> disables all diversity
          mechanisms — pure score-greedy, same as the legacy algorithm.
          <strong className="text-text-primary"> 100</strong> applies maximum type decay, floor boosts,
          and bucket-spread penalties.
          The sweet spot for most races is <strong className="text-text-primary">50–70</strong>.
        </Body>

        {/* ── Normalization ── */}
        <SubLabel>Score Normalization</SubLabel>
        <GuideBox>
          <DemoSelect label="Score Normalization" value="Cross-type (recommended)" />
        </GuideBox>
        <div className="space-y-2">
          <Body>
            <strong className="text-text-primary">Cross-type (recommended):</strong> All positive
            raw scores are stretched onto a single 0.5–10 scale. Your weight sliders then act as
            honest cross-type multipliers — a "Battle" at 80 genuinely outcompetes an "Incident"
            at 40 regardless of how common each is.
          </Body>
          <Body>
            <strong className="text-text-primary">Per-type (legacy):</strong> Each event type is
            normalised independently within its own 0.5–10 range. This was the original behaviour —
            it makes every type span the full range, so a weak pit stop can equal a strong battle
            if their sliders match. Use the "Pure Score (Legacy)" preset to reproduce old output.
          </Body>
        </div>

        {/* ── Mix Targets table ── */}
        <SubLabel>Mix Targets — per-type min · target · max</SubLabel>
        <GuideBox>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xxs w-16" />
            <span className="text-xxs text-text-disabled w-12 text-center">min %</span>
            <span className="text-xxs text-text-disabled w-12 text-center">target %</span>
            <span className="text-xxs text-text-disabled w-12 text-center">max %</span>
          </div>
          <DemoMixRow label="Battle" />
          <DemoMixRow label="Overtake" />
          <DemoMixRow label="Incident" />
        </GuideBox>

        <div className="space-y-3">
          <div className="p-2.5 rounded-lg bg-bg-primary border border-border">
            <p className="text-xxs font-semibold text-text-primary mb-0.5">
              min <span className="font-normal text-text-tertiary">(soft floor — % of script time)</span>
            </p>
            <p className="text-xxs text-text-secondary leading-relaxed">
              If this type's share of selected clips falls below this percentage, a score boost is applied
              to nudge more of it in. A floor-rebalance pass at the end can swap out a weak event to make room
              if the floor still isn't met. Leave blank to apply no floor.
            </p>
          </div>
          <div className="p-2.5 rounded-lg bg-bg-primary border border-accent/20">
            <p className="text-xxs font-semibold text-text-primary mb-0.5">
              target <span className="font-normal text-text-tertiary">(display guide — % of script time)</span>
            </p>
            <p className="text-xxs text-text-secondary leading-relaxed">
              Your intended share for this type. Not enforced directly by the algorithm — it's a reference
              value for choosing your min and max. The built-in presets use it to pre-fill sensible defaults.
            </p>
          </div>
          <div className="p-2.5 rounded-lg bg-bg-primary border border-border">
            <p className="text-xxs font-semibold text-text-primary mb-0.5">
              max <span className="font-normal text-text-tertiary">(hard cap — % of script time)</span>
            </p>
            <p className="text-xxs text-text-secondary leading-relaxed">
              Selection of this type stops once it has consumed this fraction of the target duration.
              The effective score for any further events of this type drops to zero. Leave blank for no cap.
            </p>
          </div>
        </div>

        {/* ── Advanced ── */}
        <SubLabel>Advanced</SubLabel>
        <GuideBox>
          <DemoSlider label="Type Decay Base" value={0.85} min={0.5} max={1.0} displayValue="0.85" />
          <DemoSlider label="Bucket Repeat Penalty" value={0.25} min={0} max={1.0} displayValue="0.25" />
        </GuideBox>
        <div className="space-y-2">
          <Body>
            <strong className="text-text-primary">Type Decay Base:</strong> Controls how steeply the
            effective score of each successive event of the same type falls. Formula:
            score × base^(count × scale), where scale = Diversity Strength ÷ 50.
            Lower values (0.7–0.8) produce aggressive falloff; 1.0 = no decay regardless of strength.
          </Body>
          <Body>
            <strong className="text-text-primary">Bucket Repeat Penalty:</strong> The script is split
            into early / mid / late temporal buckets. This factor penalises stacking the same event type
            into the same bucket — encouraging temporal spread across the race. 0 = off.
          </Body>
        </div>

        <Note>
          All three diversity mechanisms are proportional to Diversity Strength. Setting it to 0
          deactivates all of them at once — no decay, no floor, no bucket penalty.
        </Note>
      </div>
    ),
  },

  {
    id: 'drivercoverage',
    icon: Users,
    label: 'Driver Coverage',
    content: (
      <div className="space-y-5">
        <SectionTitle>Driver Coverage</SectionTitle>
        <Body>
          By default the algorithm is pure score-greedy — a race where three front-runners battle
          constantly will fill your entire reel with those same faces. Driver Coverage adds a soft
          incentive to spread airtime across the field, without sacrificing race-story or hard-earned
          S/A-tier moments.
        </Body>

        <div className="space-y-2">
          {[
            { label: 'Score factor',     desc: 'Events featuring drivers not yet seen get a gentle score boost. Events where every driver is already well covered receive a small penalty.' },
            { label: 'Rebalance pass',   desc: 'After main selection a swap pass replaces the weakest B/C non-mandatory clips with new-driver candidates — subject to a score floor so quality never collapses.' },
            { label: 'Always safe',      desc: 'Mandatory events (race start/finish), forced overrides, and S/A-tier clips are never touched by the rebalance pass.' },
          ].map(({ label, desc }) => (
            <div key={label} className="flex gap-3 p-2.5 rounded-xl bg-bg-primary border border-border">
              <ChevronRight size={13} className="text-accent shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-text-primary">{label}</p>
                <p className="text-xxs text-text-tertiary mt-0.5 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Coverage Strength */}
        <SubLabel>Coverage Strength — master knob</SubLabel>
        <GuideBox>
          <DemoSlider label="Coverage Strength" value={35} min={0} max={100} displayValue="35" accent />
        </GuideBox>
        <Body>
          The master dial for this layer. <strong className="text-text-primary">0</strong> disables
          everything — no factor is applied and no swaps occur, identical to pre-feature behaviour.
          The default of <strong className="text-text-primary">35</strong> gives a gentle nudge towards
          broader coverage without overriding race story. Push to
          <strong className="text-text-primary"> 70–100</strong> only if you explicitly want equal
          airtime over narrative quality.
        </Body>

        {/* New Driver Boost + Repeat Penalty */}
        <SubLabel>Boost &amp; Penalty knobs</SubLabel>
        <GuideBox>
          <DemoSlider label="New Driver Boost"  value={1.40} min={1.0} max={2.0} displayValue="1.40×" />
          <DemoSlider label="Repeat Penalty"    value={0.25} min={0}   max={0.75} displayValue="0.25" />
        </GuideBox>
        <div className="space-y-2">
          <Body>
            <strong className="text-text-primary">New Driver Boost:</strong> The score multiplier
            ceiling applied when every driver in an event is appearing for the first time in the reel.
            1.0 = no boost. 1.40 (default) means a fully-unseen-driver event can score up to 40% higher
            than its raw score suggests.
          </Body>
          <Body>
            <strong className="text-text-primary">Repeat Penalty:</strong> The maximum fractional score
            reduction when every involved driver is already well represented. 0.25 (default) means a
            fully-repeated event scores at most 25% lower. Both knobs scale proportionally with Coverage
            Strength — at strength 0 they have zero effect.
          </Body>
        </div>

        {/* Coverage Target */}
        <SubLabel>Coverage Target</SubLabel>
        <GuideBox>
          <DemoSlider label="Coverage Target" value={0.60} min={0.30} max={0.90} displayValue="60%" />
        </GuideBox>
        <Body>
          Fraction of the field the rebalance pass aims to cover before stopping. At the default
          <strong className="text-text-primary"> 60%</strong> the pass swaps clips until at least
          60% of all race drivers have appeared at least once, or the swap cap (4) is reached,
          whichever comes first.
        </Body>

        <Note>
          Driver Coverage operates independently of Mix &amp; Diversity. You can have both active
          at the same time — Coverage Strength controls driver breadth, Diversity Strength controls
          event-type breadth. Setting either to 0 is a strict no-op.
        </Note>
      </div>
    ),
  },

  {
    id: 'direction',
    icon: Sliders,
    label: 'Direction Tuning',
    content: (
      <div className="space-y-5">
        <SectionTitle>Direction Tuning</SectionTitle>
        <Body>
          Fine-grained control over the race-context scoring modifiers and camera director behaviour.
          These settings don't change which events are detected — they change how they're scored
          and presented.
        </Body>

        {/* Battle tuning */}
        <SubLabel>Battle Controls</SubLabel>
        <GuideBox>
          <DemoSlider label="Battle Hold"   value={15} min={5}   max={30}  displayValue="15s" />
          <DemoSlider label="Front Bias"    value={1.3} min={1.0} max={2.5} displayValue="1.3×" />
          <DemoSlider label="Gap Intensity" value={0.5} min={0}   max={2.0} displayValue="0.5×" />
        </GuideBox>
        <div className="space-y-2">
          <Body>
            <strong className="text-text-primary">Battle Hold:</strong> Seconds to follow one battle
            before cutting to another. Higher values = more sustained coverage per battle.
          </Body>
          <Body>
            <strong className="text-text-primary">Front Bias:</strong> Extra score multiplier for
            front-of-field battles. 1.0 = no bias; 2.0 = front-runners score twice as high.
          </Body>
          <Body>
            <strong className="text-text-primary">Gap Intensity:</strong> Boosts tightly-fought battles
            where the average gap is smaller. 0 = disabled. Higher values prefer wheel-to-wheel over distant trailing.
          </Body>
        </div>

        {/* Camera */}
        <SubLabel>Camera Behaviour</SubLabel>
        <GuideBox>
          <DemoSlider label="Camera Hold"    value={15}  min={5}   max={30}   displayValue="15s" />
          <DemoSlider label="Cam Variability" value={5}  min={0}   max={15}   displayValue="±5s" />
          <DemoSlider label="Driver Change"   value={30} min={0}   max={100}  displayValue="30%" />
          <DemoSlider label="Driver Recency"  value={0.5} min={0}  max={1.0}  displayValue="0.50" />
          <DemoSlider label="Driver Decay"    value={60}  min={10} max={300}  displayValue="60s" />
        </GuideBox>
        <div className="space-y-2">
          <Body>
            <strong className="text-text-primary">Camera Hold</strong> and <strong className="text-text-primary">Variability:</strong> How
            long to stay on one camera before considering a cut. Variability adds randomness
            (e.g. ±5s) so cuts don't feel metronomic.
          </Body>
          <Body>
            <strong className="text-text-primary">Driver Change:</strong> Probability of switching to
            a different driver on each camera cut. 0% = always follow the same driver; 100% = always switch.
          </Body>
          <Body>
            <strong className="text-text-primary">Driver Recency</strong> and <strong className="text-text-primary">Decay:</strong> Penalise
            showing the same driver too soon after they last appeared. Strength 0.5 + decay 60s is
            a good default for variety without ignoring your main protagonists.
          </Body>
        </div>

        {/* Race phase */}
        <SubLabel>Race Phase Boosts</SubLabel>
        <GuideBox>
          <DemoSlider label="First Lap Boost"   value={1.5} min={0.5} max={3.0} displayValue="1.5×" />
          <DemoSlider label="First Lap Window"  value={60}  min={0}   max={120} displayValue="60s" />
          <DemoSlider label="Last Lap Boost"    value={1.5} min={0.5} max={3.0} displayValue="1.5×" />
          <DemoSlider label="Last Lap Window"   value={60}  min={0}   max={120} displayValue="60s" />
          <DemoSlider label="Late Race At"      value={0.9} min={0.5} max={0.95} displayValue="90%" />
          <DemoSlider label="Late Race Boost"   value={1.2} min={1.0} max={2.0} displayValue="1.2×" />
        </GuideBox>
        <Body>
          Apply score multipliers to events that fall within critical race phases.
          "Window" values set how many seconds (from start / before end) define the phase.
          "Late Race At" uses a fraction of total race duration (0.9 = last 10% of the race).
        </Body>
        <GuideBox>
          <DemoToggle label="Skip 1st Lap Incidents" on={false} />
        </GuideBox>
        <Body>
          When enabled, incidents detected during the first-lap window are excluded.
          Useful for chaotic multi-car pile-ups at turn 1 that you don't want dominating
          your opening shots.
        </Body>

        {/* Other */}
        <SubLabel>Other Scoring Controls</SubLabel>
        <GuideBox>
          <DemoSlider label="Overtake Boost"     value={1.5} min={1.0} max={3.0} displayValue="1.5×" />
          <DemoSlider label="Incident Pos Cutoff" value={10} min={0}   max={40}  displayValue="P10+" />
          <DemoSlider label="PiP Threshold"       value={7.0} min={5}  max={10}  displayValue="7.0" />
          <DemoSlider label="Race Finishes"        value={5}  min={0}   max={20}  displayValue="5" />
        </GuideBox>
        <div className="space-y-2">
          <Body>
            <strong className="text-text-primary">Overtake Boost:</strong> Extra multiplier for any event
            tagged as involving a position change.
          </Body>
          <Body>
            <strong className="text-text-primary">Incident Pos Cutoff:</strong> Ignore incidents from
            cars ranked below this position. P10+ means only cars running P1–P10 are considered. 0 = include all.
          </Body>
          <Body>
            <strong className="text-text-primary">PiP Threshold:</strong> When two events overlap in time,
            they're merged into a Picture-in-Picture if both score above this threshold.
            Lower values = more PiP; higher values = one event dropped.
          </Body>
          <Body>
            <strong className="text-text-primary">Race Finishes:</strong> Maximum number of race-finish
            events in the reel. 0 = no limit (all finishes included). Useful for large grids.
          </Body>
        </div>

        {/* Preferred drivers */}
        <SubLabel>Preferred Drivers</SubLabel>
        <GuideBox>
          <DemoSlider label="Driver Boost" value={1.5} min={1.0} max={3.0} displayValue="1.5×" />
          <DemoToggle label="Preferred Only" on={false} />
          <div className="mt-1">
            <span className="text-xxs text-text-secondary block mb-0.5">Preferred Drivers</span>
            <div className="w-full px-2 py-1 text-xxs bg-bg-primary border border-border rounded text-text-disabled">
              Smith, Johnson, ...
            </div>
          </div>
        </GuideBox>
        <Body>
          Enter comma-separated name fragments. Any event involving a matching driver is boosted
          by the <strong className="text-text-primary">Driver Boost</strong> multiplier.
          Turn on <strong className="text-text-primary">Preferred Only</strong> to exclude all events
          that don't feature a preferred driver (mandatory events like race start/finish are always kept).
        </Body>
      </div>
    ),
  },

  {
    id: 'padding',
    icon: Film,
    label: 'Clip Padding',
    content: (
      <div className="space-y-4">
        <SectionTitle>Clip Padding</SectionTitle>
        <Body>
          Clip padding adds context before and after each detected event. The event itself might
          last 3 seconds, but you want 5 seconds of lead-in so the viewer can see what's happening.
        </Body>

        <SubLabel>Global defaults</SubLabel>
        <GuideBox>
          <DemoSlider label="Lead-in"    value={5}  min={0} max={15} displayValue="5s" accent />
          <DemoSlider label="Follow-out" value={8}  min={0} max={30} displayValue="8s" accent />
        </GuideBox>
        <Body>
          These apply to every event unless overridden per type or per individual event in
          the Event Inspector. Lead-in affects how early capture starts; follow-out affects
          how late it stops.
        </Body>

        <SubLabel>Per-type overrides</SubLabel>
        <GuideBox>
          <div className="flex items-center gap-1 mb-1.5">
            <span className="text-xxs text-text-disabled flex-1 uppercase tracking-wider text-xxs">Type</span>
            <span className="text-xxs text-text-disabled w-10 text-center">In</span>
            <span className="text-xxs text-text-disabled w-10 text-center">Out</span>
            <div className="w-4" />
          </div>
          {[
            { label: 'Battle',   color: '#f59e0b' },
            { label: 'Overtake', color: '#10b981' },
            { label: 'Incident', color: '#ef4444' },
          ].map(({ label, color }) => (
            <div key={label} className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
              <span className="text-xxs text-text-secondary flex-1 truncate">{label}</span>
              <div className="w-10 text-xxs text-center bg-bg-primary border border-border rounded px-1 py-0.5 font-mono text-text-disabled">—</div>
              <div className="w-10 text-xxs text-center bg-bg-primary border border-border rounded px-1 py-0.5 font-mono text-text-disabled">—</div>
              <X className="w-3 h-3 text-transparent" />
            </div>
          ))}
        </GuideBox>
        <Body>
          Enter a number to override the global default for that type. Leave blank to inherit
          the global value. For example, battles might need a longer follow-out (15s) to
          capture the resolution, while pit stops only need 3s.
        </Body>
        <Body>
          The <strong className="text-text-primary">×</strong> button on the right clears
          any override for that row and reverts to global defaults.
        </Body>

        <Note>
          Individual event overrides set in the Event Inspector take precedence over
          both type-level and global overrides. The hierarchy is:
          Individual → Per-type → Global default.
        </Note>
      </div>
    ),
  },

  {
    id: 'cameras',
    icon: Camera,
    label: 'Camera Selection',
    content: (
      <div className="space-y-4">
        <SectionTitle>Camera Selection</SectionTitle>
        <Body>
          Controls which iRacing camera groups are used during capture and how the director
          chooses between them. Camera data comes live from iRacing — connect before adjusting
          per-camera weights.
        </Body>

        <SubLabel>Section Cameras</SubLabel>
        <GuideBox>
          <div className="space-y-2">
            {['Intro', 'Qualifying', 'Results'].map(s => (
              <div key={s} className="flex items-center justify-between gap-2">
                <span className="text-xxs text-text-secondary">{s}</span>
                <div className="text-xxs bg-bg-primary border border-border rounded px-2 py-0.5 text-text-disabled flex items-center gap-1">
                  <ChevronRight size={10} />
                  TV1, Blimp
                </div>
              </div>
            ))}
          </div>
        </GuideBox>
        <Body>
          Choose preferred camera groups for non-race sections (intro card, qualifying results,
          podium). Multiple cameras can be selected; the director picks between them.
        </Body>

        <SubLabel>Race Camera Weights</SubLabel>
        <GuideBox>
          <DemoSlider label="Recency Penalty" value={0.5} min={0} max={1.0} displayValue="0.50" />
          <DemoSlider label="Penalty Decay"   value={30}  min={5} max={120} displayValue="30s" />
          <div className="mt-2 space-y-1.5">
            {[{ name: 'TV1', w: 70 }, { name: 'TV2', w: 50 }, { name: 'Blimp', w: 30 }, { name: 'Cockpit', w: 60 }].map(({ name, w }) => (
              <div key={name} className={`flex items-center gap-2`}>
                <div className="w-3 h-3 rounded-full shrink-0 border border-white/20 bg-accent/60" />
                <span className="text-xxs w-20 truncate text-text-secondary">{name}</span>
                <div className="flex-1 relative h-1 rounded-full bg-border">
                  <div className="absolute left-0 top-0 h-1 rounded-full bg-accent/60" style={{ width: `${w}%` }} />
                </div>
                <span className="text-xxs text-text-tertiary font-mono w-7 text-right">{w}</span>
              </div>
            ))}
          </div>
        </GuideBox>
        <div className="space-y-2">
          <Body>
            <strong className="text-text-primary">Recency Penalty</strong> and
            <strong className="text-text-primary"> Penalty Decay:</strong> Reduce the probability
            of choosing the same camera too soon. At 0.5 penalty / 30s decay, a camera that was
            just used takes roughly 30 seconds to recover its full weight.
          </Body>
          <Body>
            <strong className="text-text-primary">Per-camera weights:</strong> A higher weight means
            that camera is more likely to be chosen on any given cut. Click the dot to disable a camera
            entirely (weight 0). The probability chart at the bottom shows the effective chances.
          </Body>
        </div>

        <Note>
          Camera groups come from the live iRacing session. If no cameras are listed, open a
          replay in iRacing and refresh. Saved weights apply even when iRacing is disconnected —
          they're stored with your project config.
        </Note>
      </div>
    ),
  },

  {
    id: 'presets',
    icon: null,
    label: 'Presets',
    content: (
      <div className="space-y-4">
        <SectionTitle>Presets</SectionTitle>
        <Body>
          A preset is a named snapshot of your entire scoring configuration — event weights,
          target duration, minimum severity, and all Mix &amp; Diversity parameters. Applying a
          preset replaces all of those settings at once, giving you a reliable starting point
          for different race types.
        </Body>
        <Body>
          Presets are stored <strong className="text-text-primary">globally on the server</strong>,
          not per-project, so the same set of presets is available regardless of which race you have open.
          They are completely separate from the project augmentation presets in the toolbar (those
          store per-project overlays and video settings).
        </Body>
        <SubLabel>Built-in presets</SubLabel>
        <div className="space-y-2">
          {[
            {
              name: 'Balanced Mix',
              desc: 'Diversity Strength 70 with floors and caps across battles, overtakes, contacts, and story events. Good general-purpose starting point.',
              color: 'bg-accent/10 border-accent/30',
            },
            {
              name: 'Action Heavy',
              desc: 'Incident and contact events weighted highest. Battles and overtakes capped to leave room for crashes. Best for chaotic races.',
              color: 'bg-red-500/10 border-red-500/30',
            },
            {
              name: 'Story-Driven',
              desc: 'Battles, overtakes, and leader changes front-and-centre. Incidents capped low. Best for close championship fights.',
              color: 'bg-purple-500/10 border-purple-500/30',
            },
            {
              name: 'Battles Only',
              desc: 'Battle floor at 50% of script time. Everything else heavily capped. Use when you want sustained wheel-to-wheel coverage.',
              color: 'bg-yellow-500/10 border-yellow-500/30',
            },
            {
              name: 'Pure Score (Legacy)',
              desc: 'Diversity Strength 0 + per-type normalization. Exact reproduction of the original algorithm. No floors, caps, or decay — highest score always wins.',
              color: 'bg-border/20 border-border',
            },
          ].map(({ name, desc, color }) => (
            <div key={name} className={`p-2.5 rounded-xl border ${color}`}>
              <p className="text-xs font-semibold text-text-primary">{name}</p>
              <p className="text-xxs text-text-secondary mt-0.5 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
        <Note>
          Presets do not conflict with the toolbar's project presets. Highlight presets store
          scoring &amp; selection parameters; project presets store replay augmentations, overlay
          settings, and video pipeline configuration. They operate on completely separate data.
        </Note>
      </div>
    ),
  },
]

/* ─────────────────────────────────────────────────────────────────────────
   Main modal component
───────────────────────────────────────────────────────────────────────── */

function HighlightControlsHelp({ onClose }) {
  const [activeId, setActiveId] = useState('overview')
  const overlayRef = useRef(null)
  const contentRef = useRef(null)

  // Keyboard close
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Scroll content to top when section changes
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [activeId])

  const active = SECTIONS.find(s => s.id === activeId) || SECTIONS[0]

  return (
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm
                 animate-fade-in p-4"
    >
      <div className="bg-bg-tertiary border border-border rounded-2xl shadow-float w-full max-w-4xl
                      animate-scale-in flex flex-col"
           style={{ maxHeight: 'calc(100vh - 2rem)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <HelpCircle className="w-5 h-5 text-accent" />
            <h2 className="text-base font-semibold text-text-primary">Editing Controls Guide</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-surface-hover transition-all duration-150 cursor-pointer"
          >
            <X className="w-5 h-5 text-text-tertiary" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">

          {/* Sidebar */}
          <nav className="w-44 shrink-0 border-r border-border py-3 px-2 flex flex-col gap-0.5 overflow-y-auto">
            {SECTIONS.map(({ id, icon: Icon, label }) => {
              const isActive = id === activeId
              return (
                <button
                  key={id}
                  onClick={() => setActiveId(id)}
                  className={`flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg text-left
                              transition-colors text-xs font-medium
                              ${isActive
                                ? 'bg-accent/15 text-accent'
                                : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                              }`}
                >
                  {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
                  {!Icon && <span className="w-3.5 h-3.5 shrink-0" />}
                  {label}
                </button>
              )
            })}
          </nav>

          {/* Content */}
          <div
            ref={contentRef}
            className="flex-1 overflow-y-auto p-6"
          >
            {active.content}
          </div>
        </div>
      </div>
    </div>
  )
}

export default HighlightControlsHelp
