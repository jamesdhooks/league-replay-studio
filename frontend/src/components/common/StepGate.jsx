import { ChevronLeft } from 'lucide-react'
import { useProject } from '../../context/ProjectContext'

const STEP_ORDER = ['analysis', 'editing', 'overlay', 'capture', 'export', 'upload']

const STEP_INFO = {
  analysis: {
    title: 'Analysis Required',
    description: 'Run replay analysis first to detect race events before proceeding.',
    cta: 'Go to Analysis',
    target: 'analysis',
  },
  editing: {
    title: 'Editing Required',
    description: 'Configure your highlight reel and timeline before capture.',
    cta: 'Go to Editing',
    target: 'editing',
  },
  overlay: {
    title: 'Analysis Required',
    description: 'Run replay analysis before designing overlay templates.',
    cta: 'Go to Analysis',
    target: 'analysis',
  },
  capture: {
    title: 'Capture Required',
    description: 'Record the replay before you can export it.',
    cta: 'Go to Capture',
    target: 'capture',
  },
  export: {
    title: 'Export Required',
    description: 'Export the video before uploading.',
    cta: 'Go to Export',
    target: 'export',
  },
}

/**
 * StepGate — shown when a user navigates to a step whose prerequisites aren't met.
 * Displays a friendly CTA pushing them back to the required previous step.
 *
 * @param {string} currentStep - The step the user is trying to view
 * @param {string} requiredStep - The step that needs to be completed first
 */
export default function StepGate({ currentStep, requiredStep }) {
  const { activeProject, setStep } = useProject()

  const info = STEP_INFO[requiredStep] || {
    title: 'Previous Step Required',
    description: 'Complete the previous step before continuing.',
    cta: 'Go Back',
    target: requiredStep,
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="flex flex-col items-center gap-4 max-w-sm text-center">
        <div className="w-14 h-14 rounded-2xl bg-surface-active flex items-center justify-center">
          <ChevronLeft size={28} className="text-text-tertiary" />
        </div>
        <h2 className="text-lg font-semibold text-text-primary">{info.title}</h2>
        <p className="text-sm text-text-secondary leading-relaxed">
          {info.description}
        </p>
        <button
          onClick={() => activeProject && setStep(activeProject.id, info.target)}
          className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold
                     text-white bg-gradient-to-r from-gradient-from to-gradient-to
                     rounded-xl hover:from-gradient-via hover:to-gradient-from
                     transition-all duration-200 shadow-glow-sm hover:shadow-glow"
        >
          <ChevronLeft size={15} />
          {info.cta}
        </button>
      </div>
    </div>
  )
}
