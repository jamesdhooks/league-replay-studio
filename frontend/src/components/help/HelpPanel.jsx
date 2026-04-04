import { useState } from 'react'
import {
  X, BarChart3, Scissors, Film, Download, Upload,
  Wifi, Monitor, ChevronRight, Zap, AlertTriangle,
  Swords, ArrowUpDown, Fuel, Crown, Flag,
} from 'lucide-react'

const SECTIONS = [
  {
    id: 'overview',
    label: 'Overview',
    icon: Zap,
  },
  {
    id: 'workflow',
    label: 'Workflow',
    icon: ChevronRight,
  },
  {
    id: 'analysis',
    label: 'Analysis',
    icon: BarChart3,
  },
  {
    id: 'editing',
    label: 'Editing',
    icon: Scissors,
  },
  {
    id: 'capture',
    label: 'Capture',
    icon: Film,
  },
  {
    id: 'export',
    label: 'Export & Upload',
    icon: Upload,
  },
  {
    id: 'iracing',
    label: 'iRacing Setup',
    icon: Wifi,
  },
  {
    id: 'capture-software',
    label: 'Capture Software',
    icon: Monitor,
  },
]

const CONTENT = {
  overview: (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-text-primary">What is League Replay Studio?</h2>
      <p className="text-sm text-text-secondary leading-relaxed">
        League Replay Studio (LRS) is an automated highlight reel tool for iRacing leagues. It
        connects to iRacing's replay system to scan your race at 16× speed, automatically detects
        key moments (incidents, battles, overtakes, fastest laps, and more), lets you tune the
        highlight selection, then orchestrates your capture software to record the final video.
      </p>
      <p className="text-sm text-text-secondary leading-relaxed">
        The full pipeline is: <strong className="text-text-primary">Analysis → Editing → Capture → Export → Upload</strong>.
        Each step can run automatically or be paused for manual review.
      </p>
      <div className="grid grid-cols-2 gap-3 pt-2">
        {[
          { icon: BarChart3, label: 'Auto event detection', desc: 'Finds incidents, battles, overtakes at 16×' },
          { icon: Scissors,  label: 'Smart timeline',       desc: 'All detected events, severity-ranked' },
          { icon: Film,      label: 'Guided capture',       desc: 'OBS/ShadowPlay/ReLive hotkey control' },
          { icon: Upload,    label: 'Direct upload',        desc: 'Push finished video to YouTube' },
        ].map(({ icon: Icon, label, desc }) => (
          <div key={label} className="flex gap-3 p-3 rounded-xl bg-surface border border-border">
            <Icon size={16} className="text-accent shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-text-primary">{label}</p>
              <p className="text-xxs text-text-tertiary mt-0.5">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  ),

  workflow: (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-text-primary">Pipeline Workflow</h2>
      <p className="text-sm text-text-secondary">Projects progress through five steps. You can jump back to any completed step.</p>
      <div className="space-y-3">
        {[
          { step: '1', icon: BarChart3, label: 'Analysis',    color: 'text-event-battle',   desc: 'LRS drives the replay at 16× speed and reads iRacing telemetry every ~20ms. It builds a SQLite database of every car position, surface state, and camera switch, then runs 8 event detectors across that data.' },
          { step: '2', icon: Scissors,  label: 'Editing',     color: 'text-event-overtake', desc: 'Review the detected events on the timeline. Toggle events on/off, adjust severity weights, and set a target highlight duration. LRS scores and ranks events automatically.' },
          { step: '3', icon: Film,      label: 'Capture',     color: 'text-accent',         desc: 'LRS rewinds the replay to the race start, then plays at 1× while sending hotkeys to your capture software. In highlights mode it seeks between events, pausing recording between them.' },
          { step: '4', icon: Download,  label: 'Export',      color: 'text-event-pit',      desc: 'GPU-accelerated encoding via FFmpeg. Choose resolution, bitrate, and codec (H.264/H.265/AV1). Burn-in overlays are composited at this stage.' },
          { step: '5', icon: Upload,    label: 'Upload',      color: 'text-event-leader',   desc: 'Push the encoded video directly to YouTube with title, description, tags, and privacy settings filled from your project metadata.' },
        ].map(({ step, icon: Icon, label, color, desc }) => (
          <div key={step} className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-surface border border-border flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-xxs font-bold text-text-tertiary">{step}</span>
            </div>
            <div className="flex-1 pb-3 border-b border-border last:border-0">
              <div className="flex items-center gap-2 mb-1">
                <Icon size={14} className={color} />
                <span className="text-sm font-medium text-text-primary">{label}</span>
              </div>
              <p className="text-xs text-text-secondary leading-relaxed">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  ),

  analysis: (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-text-primary">Analysis — How Events Are Detected</h2>
      <p className="text-sm text-text-secondary leading-relaxed">
        The analysis engine makes two passes over the replay data:
      </p>
      <ol className="list-decimal list-inside space-y-2 text-sm text-text-secondary pl-1">
        <li><strong className="text-text-primary">Scan pass</strong> — Drives replay at 16× from race start, sampling telemetry at ~50Hz into SQLite.</li>
        <li><strong className="text-text-primary">Detect pass</strong> — Runs 8 SQL-based detectors over the cached data (no iRacing connection needed).</li>
      </ol>
      <div className="grid grid-cols-2 gap-2 pt-1">
        {[
          { icon: AlertTriangle, label: 'Incidents',      color: 'text-event-incident',  desc: 'Camera switches to an off-track car' },
          { icon: Swords,        label: 'Battles',        color: 'text-event-battle',    desc: 'Adjacent cars within gap threshold for 10+ seconds' },
          { icon: ArrowUpDown,   label: 'Overtakes',      color: 'text-event-overtake',  desc: 'Position swap with proximity verification' },
          { icon: Fuel,          label: 'Pit Stops',      color: 'text-event-pit',       desc: 'Car on pit surface for 5+ seconds' },
          { icon: Zap,           label: 'Fastest Laps',   color: 'text-event-fastest',   desc: 'New personal or session best lap time' },
          { icon: Crown,         label: 'Leader Changes', color: 'text-event-leader',    desc: 'P1 car index changes on-track' },
          { icon: Flag,          label: 'First / Last Lap', color: 'text-event-firstlap', desc: 'Opening and closing laps of the race' },
        ].map(({ icon: Icon, label, color, desc }) => (
          <div key={label} className="flex gap-2 p-2.5 rounded-lg bg-surface border border-border">
            <Icon size={13} className={`${color} shrink-0 mt-0.5`} />
            <div>
              <p className="text-xxs font-medium text-text-primary">{label}</p>
              <p className="text-xxs text-text-tertiary mt-0.5">{desc}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-text-tertiary">
        Each event has a severity score (1–10). Higher severity = more likely to be included in a highlight reel.
      </p>
    </div>
  ),

  editing: (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-text-primary">Editing the Highlight Timeline</h2>
      <p className="text-sm text-text-secondary leading-relaxed">
        The editing panel shows all detected events as cards. You can:
      </p>
      <ul className="space-y-2 text-sm text-text-secondary">
        <li className="flex gap-2"><ChevronRight size={14} className="text-accent shrink-0 mt-0.5" /><span>Toggle individual events on or off for capture</span></li>
        <li className="flex gap-2"><ChevronRight size={14} className="text-accent shrink-0 mt-0.5" /><span>Adjust severity weights per event type to tune automatic selection</span></li>
        <li className="flex gap-2"><ChevronRight size={14} className="text-accent shrink-0 mt-0.5" /><span>Set a target total video duration — LRS greedily selects the highest-scoring events that fit</span></li>
        <li className="flex gap-2"><ChevronRight size={14} className="text-accent shrink-0 mt-0.5" /><span>Re-run analysis without losing your manual overrides</span></li>
      </ul>
    </div>
  ),

  capture: (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-text-primary">Capture</h2>
      <p className="text-sm text-text-secondary leading-relaxed">
        LRS controls your capture software via configurable hotkeys. It does not control OBS/ShadowPlay
        directly via their APIs — it sends keystrokes to toggle recording on/off.
      </p>
      <div className="space-y-3 text-sm text-text-secondary">
        <div className="p-3 rounded-xl bg-surface border border-border">
          <p className="font-medium text-text-primary mb-1">Full Race mode</p>
          <p className="text-xs">Rewinds to race start, hits record, plays at 1× speed, stops when race reaches cooldown. You get one continuous video file.</p>
        </div>
        <div className="p-3 rounded-xl bg-surface border border-border">
          <p className="font-medium text-text-primary mb-1">Highlights mode</p>
          <p className="text-xs">Seeks between selected events, starts recording a few seconds before each event, stops a few seconds after. Produces individual clips per event.</p>
        </div>
      </div>
      <p className="text-xs text-text-tertiary">
        Make sure your capture software is running and the hotkeys in Settings → Hotkeys match what you have configured in OBS/ShadowPlay.
      </p>
    </div>
  ),

  export: (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-text-primary">Export & Upload</h2>
      <p className="text-sm text-text-secondary leading-relaxed">
        Export encodes the capture file using FFmpeg with GPU acceleration when available:
      </p>
      <ul className="space-y-2 text-sm text-text-secondary">
        <li className="flex gap-2"><ChevronRight size={14} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-text-primary">NVIDIA:</strong> NVENC (H.264 / H.265)</span></li>
        <li className="flex gap-2"><ChevronRight size={14} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-text-primary">AMD:</strong> AMF (H.264 / H.265)</span></li>
        <li className="flex gap-2"><ChevronRight size={14} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-text-primary">Intel:</strong> QSV (H.264)</span></li>
        <li className="flex gap-2"><ChevronRight size={14} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-text-primary">CPU fallback:</strong> libx264 / libx265</span></li>
      </ul>
      <p className="text-sm text-text-secondary">
        After export, the Upload step can push the video to YouTube using OAuth credentials configured in Settings → YouTube.
      </p>
    </div>
  ),

  iracing: (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-text-primary">iRacing Setup</h2>
      <p className="text-sm text-text-secondary leading-relaxed">
        LRS connects to iRacing via the iRacing SDK shared memory interface. No special configuration
        is needed — just make sure iRacing is running when you start analysis or capture.
      </p>
      <div className="space-y-2">
        <div className="p-3 rounded-xl bg-surface border border-border text-sm">
          <p className="font-medium text-text-primary mb-1">Connection status</p>
          <p className="text-xs text-text-secondary">The toolbar shows a green "iRacing · Track" indicator when connected. If disconnected, open iRacing before starting a pipeline step that requires it.</p>
        </div>
        <div className="p-3 rounded-xl bg-surface border border-border text-sm">
          <p className="font-medium text-text-primary mb-1">Replay files</p>
          <p className="text-xs text-text-secondary">Load your <code className="text-accent">.ibt</code> replay file into iRacing first (Replay → Load). LRS will detect the session when you start analysis.</p>
        </div>
        <div className="p-3 rounded-xl bg-surface border border-border text-sm">
          <p className="font-medium text-text-primary mb-1">Broadcasting API</p>
          <p className="text-xs text-text-secondary">LRS uses iRacing's Broadcasting API to control replay speed, seek to frames, and switch cameras. This is the same API used by iRacing's own replay director.</p>
        </div>
      </div>
    </div>
  ),

  'capture-software': (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-text-primary">Capture Software Setup</h2>
      <p className="text-sm text-text-secondary">Configure your recording software in <strong className="text-text-primary">Settings → Pipeline</strong>.</p>
      <div className="space-y-3">
        {[
          { name: 'OBS Studio', id: 'obs', tip: 'Set a global hotkey in OBS Settings → Hotkeys for "Start Recording" and "Stop Recording". The default hotkeys are not set — you must configure them manually.' },
          { name: 'NVIDIA ShadowPlay', id: 'shadowplay', tip: 'Enable ShadowPlay in GeForce Experience. Go to Settings → Keyboard Shortcuts and note the "Toggle Recording" shortcut (default Alt+F9). LRS will use this.' },
          { name: 'AMD ReLive', id: 'relive', tip: 'Enable ReLive in Radeon Software. The default record toggle is Ctrl+Shift+R. Confirm this in Radeon Software → Settings → ReLive.' },
          { name: 'Manual', id: 'manual', tip: 'LRS will not send any hotkeys. You manage recording yourself — useful for testing or unsupported software.' },
        ].map(({ name, tip }) => (
          <div key={name} className="p-3 rounded-xl bg-surface border border-border">
            <p className="text-xs font-medium text-text-primary mb-1">{name}</p>
            <p className="text-xxs text-text-secondary leading-relaxed">{tip}</p>
          </div>
        ))}
      </div>
    </div>
  ),
}

/**
 * HelpPanel — full-screen help modal with sidebar navigation.
 *
 * @param {Object} props
 * @param {() => void} props.onClose
 */
export default function HelpPanel({ onClose }) {
  const [activeSection, setActiveSection] = useState('overview')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-3xl h-[600px] bg-bg-primary border border-border rounded-2xl
                      shadow-2xl flex overflow-hidden">

        {/* Sidebar */}
        <aside className="w-44 shrink-0 bg-bg-secondary border-r border-border flex flex-col py-3">
          <div className="px-4 pb-3 border-b border-border mb-2">
            <p className="text-xs font-semibold text-text-primary">Help</p>
          </div>
          <nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveSection(id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left
                             transition-colors text-xs
                             ${activeSection === id
                               ? 'bg-accent/10 text-accent font-medium'
                               : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                             }`}
              >
                <Icon size={13} className="shrink-0" />
                {label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
            <p className="text-sm font-semibold text-text-primary">
              {SECTIONS.find(s => s.id === activeSection)?.label}
            </p>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-surface-hover text-text-secondary
                         hover:text-text-primary transition-colors"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {CONTENT[activeSection]}
          </div>
        </div>

      </div>
    </div>
  )
}
