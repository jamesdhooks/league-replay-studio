import { useState, useEffect } from 'react'
import { Wand2, ChevronLeft, ChevronRight, Check, X } from 'lucide-react'

const STEPS = [
  { id: 1, label: 'Welcome' },
  { id: 2, label: 'Capture' },
  { id: 3, label: 'GPU' },
  { id: 4, label: 'Project Dir' },
  { id: 5, label: 'YouTube' },
]

/**
 * Multi-step first-run setup wizard displayed as a centered modal overlay.
 *
 * @param {Object}   props
 * @param {function} props.onComplete - Called with collected settings when wizard finishes
 * @param {function} props.onSkip    - Called when user skips the wizard entirely
 */
function SetupWizard({ onComplete, onSkip }) {
  const [step, setStep] = useState(1)
  const [detected, setDetected] = useState(null)

  // Collected settings across all steps
  const [iracing_replay_dir, setIracingReplayDir] = useState('')
  const [capture_software, setCaptureSoftware] = useState('obs')
  const [capture_hotkey_start, setCaptureHotkeyStart] = useState('F9')
  const [capture_hotkey_stop, setCaptureHotkeyStop] = useState('F9')
  const [preferred_gpu, setPreferredGpu] = useState('auto')
  const [default_project_dir, setDefaultProjectDir] = useState('')

  useEffect(() => {
    fetch('/api/wizard/detect')
      .then((r) => r.json())
      .then((data) => {
        setDetected(data)
        if (data.iracing_dirs?.length > 0) {
          setIracingReplayDir(data.iracing_dirs[0])
        }
        if (data.capture_software) {
          setCaptureSoftware(data.capture_software)
        }
      })
      .catch(() => {
        // detection failed — user fills in manually
      })
  }, [])

  const handleFinish = () => {
    onComplete({
      iracing_replay_dir,
      capture_software,
      capture_hotkey_start,
      capture_hotkey_stop,
      preferred_gpu,
      default_project_dir,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl mx-4 rounded-xl bg-surface border border-border shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-border">
          <div className="flex items-center gap-2 text-text-primary">
            <Wand2 className="w-5 h-5 text-accent" />
            <span className="font-semibold text-lg">Setup Wizard</span>
          </div>
          <button
            onClick={onSkip}
            className="text-text-tertiary hover:text-text-primary transition-colors text-sm underline"
          >
            Skip wizard
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 px-6 py-4">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                  s.id < step
                    ? 'bg-accent text-white'
                    : s.id === step
                    ? 'bg-accent/20 text-accent border-2 border-accent'
                    : 'bg-surface-hover text-text-tertiary'
                }`}
              >
                {s.id < step ? <Check className="w-4 h-4" /> : s.id}
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`h-px w-8 transition-colors ${
                    s.id < step ? 'bg-accent' : 'bg-border'
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="flex-1 px-6 py-4 min-h-[280px]">
          {step === 1 && (
            <Step1Welcome
              detected={detected}
              iracingDir={iracing_replay_dir}
              setIracingDir={setIracingReplayDir}
            />
          )}
          {step === 2 && (
            <Step2Capture
              detected={detected}
              captureSoftware={capture_software}
              setCaptureSoftware={setCaptureSoftware}
              hotkeyStart={capture_hotkey_start}
              setHotkeyStart={setCaptureHotkeyStart}
              hotkeyStop={capture_hotkey_stop}
              setHotkeyStop={setCaptureHotkeyStop}
            />
          )}
          {step === 3 && (
            <Step3Gpu
              detected={detected}
              preferredGpu={preferred_gpu}
              setPreferredGpu={setPreferredGpu}
            />
          )}
          {step === 4 && (
            <Step4ProjectDir
              projectDir={default_project_dir}
              setProjectDir={setDefaultProjectDir}
            />
          )}
          {step === 5 && <Step5YouTube />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border">
          <button
            onClick={() => setStep((s) => s - 1)}
            disabled={step === 1}
            className="flex items-center gap-1 px-4 py-2 rounded-lg text-sm text-text-secondary hover:text-text-primary hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </button>

          <span className="text-xs text-text-tertiary">
            Step {step} of {STEPS.length}
          </span>

          {step < STEPS.length ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              className="flex items-center gap-1 px-4 py-2 rounded-lg text-sm bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handleFinish}
              className="flex items-center gap-1 px-4 py-2 rounded-lg text-sm bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              <Check className="w-4 h-4" />
              Finish
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Steps ────────────────────────────────────────────────────────────────────

function Step1Welcome({ detected, iracingDir, setIracingDir }) {
  const dirs = detected?.iracing_dirs ?? []
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Welcome to League Replay Studio</h2>
        <p className="text-sm text-text-tertiary mt-1">
          Let's configure a few things to get you started. First, tell us where your iRacing replays are stored.
        </p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-text-primary">
          iRacing Replay Directory
        </label>
        {dirs.length > 0 && (
          <select
            value={iracingDir}
            onChange={(e) => setIracingDir(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-text-primary text-sm focus:outline-none focus:border-accent"
          >
            {dirs.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
            <option value="">Custom path…</option>
          </select>
        )}
        {(dirs.length === 0 || !dirs.includes(iracingDir)) && (
          <input
            type="text"
            value={iracingDir}
            onChange={(e) => setIracingDir(e.target.value)}
            placeholder="e.g. C:\Users\You\Documents\iRacing\replays"
            className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-text-primary text-sm focus:outline-none focus:border-accent"
          />
        )}
        {dirs.length > 0 && (
          <p className="text-xs text-accent">✓ iRacing directory auto-detected</p>
        )}
      </div>
    </div>
  )
}

function Step2Capture({ detected, captureSoftware, setCaptureSoftware, hotkeyStart, setHotkeyStart, hotkeyStop, setHotkeyStop }) {
  const found = detected?.capture_software_found ?? []
  const options = [
    { id: 'obs', label: 'OBS Studio' },
    { id: 'shadowplay', label: 'NVIDIA ShadowPlay' },
    { id: 'relive', label: 'AMD ReLive' },
    { id: 'manual', label: 'Manual / Other' },
  ]

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Capture Software</h2>
        <p className="text-sm text-text-tertiary mt-1">
          Which software do you use to record your replays?
        </p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-text-primary">Capture Software</label>
        <div className="grid grid-cols-2 gap-2">
          {options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setCaptureSoftware(opt.id)}
              className={`flex items-center justify-between px-3 py-2 rounded-lg border text-sm transition-colors ${
                captureSoftware === opt.id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-text-secondary hover:border-accent/50 hover:text-text-primary'
              }`}
            >
              <span>{opt.label}</span>
              {found.includes(opt.id) && (
                <span className="text-xs bg-accent/20 text-accent px-1.5 py-0.5 rounded">detected</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label className="block text-sm font-medium text-text-primary">Start Hotkey</label>
          <input
            type="text"
            value={hotkeyStart}
            onChange={(e) => setHotkeyStart(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-text-primary text-sm focus:outline-none focus:border-accent"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium text-text-primary">Stop Hotkey</label>
          <input
            type="text"
            value={hotkeyStop}
            onChange={(e) => setHotkeyStop(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-text-primary text-sm focus:outline-none focus:border-accent"
          />
        </div>
      </div>
    </div>
  )
}

function Step3Gpu({ detected, preferredGpu, setPreferredGpu }) {
  const gpu = detected?.gpu
  const options = [
    { id: 'auto', label: 'Auto (recommended)' },
    { id: 'nvidia', label: 'NVIDIA (NVENC)' },
    { id: 'amd', label: 'AMD (VCE/VCN)' },
    { id: 'intel', label: 'Intel (QSV)' },
    { id: 'cpu', label: 'CPU (software)' },
  ]

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">GPU & Encoding</h2>
        <p className="text-sm text-text-tertiary mt-1">
          Choose your preferred GPU for hardware-accelerated encoding.
        </p>
      </div>

      {gpu && (
        <div className="px-3 py-2 rounded-lg bg-surface-hover border border-border text-sm text-text-secondary">
          <span className="font-medium text-text-primary">Detected: </span>
          {gpu.vendor ? `${gpu.vendor} — ${gpu.encoder ?? gpu.name ?? 'GPU'}` : 'No GPU detected'}
        </div>
      )}

      <div className="space-y-2">
        <label className="block text-sm font-medium text-text-primary">Preferred GPU</label>
        <div className="space-y-1">
          {options.map((opt) => (
            <label key={opt.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-hover cursor-pointer transition-colors">
              <input
                type="radio"
                name="preferred_gpu"
                value={opt.id}
                checked={preferredGpu === opt.id}
                onChange={() => setPreferredGpu(opt.id)}
                className="accent-accent"
              />
              <span className="text-sm text-text-primary">{opt.label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

function Step4ProjectDir({ projectDir, setProjectDir }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Project Directory</h2>
        <p className="text-sm text-text-tertiary mt-1">
          Where new projects will be saved.
        </p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-text-primary">
          Default Project Directory
        </label>
        <input
          type="text"
          value={projectDir}
          onChange={(e) => setProjectDir(e.target.value)}
          placeholder="e.g. C:\Users\You\Videos\LRS Projects"
          className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-text-primary text-sm focus:outline-none focus:border-accent"
        />
        <p className="text-xs text-text-tertiary">
          Leave blank to be prompted each time you create a project.
        </p>
      </div>
    </div>
  )
}

function Step5YouTube() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">YouTube — Optional</h2>
        <p className="text-sm text-text-tertiary mt-1">
          Connect your YouTube channel to enable auto-upload (optional).
          You can do this later in <span className="text-text-primary font-medium">Settings → YouTube</span>.
        </p>
      </div>

      <div className="px-4 py-4 rounded-lg bg-surface-hover border border-border space-y-2">
        <p className="text-sm text-text-primary font-medium">YouTube integration lets you:</p>
        <ul className="text-sm text-text-tertiary space-y-1 list-disc list-inside">
          <li>Auto-upload completed highlight videos</li>
          <li>Set default title, description, and privacy</li>
          <li>Organize uploads into playlists automatically</li>
        </ul>
      </div>

      <p className="text-xs text-text-tertiary">
        Click <span className="text-accent font-medium">Finish</span> to complete setup.
        You can connect YouTube at any time from the Settings panel.
      </p>
    </div>
  )
}

export default SetupWizard
