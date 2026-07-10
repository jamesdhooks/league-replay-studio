import { Cpu, EyeOff, Monitor, Network, Video } from 'lucide-react'

function GuideSection({ icon: Icon, title, children }) {
  return (
    <section className="border-b border-border-subtle px-5 py-4 last:border-b-0">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Icon className="h-4 w-4 text-accent" />
        <h4>{title}</h4>
      </div>
      {children}
    </section>
  )
}

function SettingRows({ rows }) {
  return (
    <div className="divide-y divide-border-subtle border border-border">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-3 px-3 py-2 text-xs">
          <span className="text-text-secondary">{label}</span>
          <span className="font-medium text-text-primary">{value}</span>
        </div>
      ))}
    </div>
  )
}

export default function ObsSetupGuide({ outputDirectory, captureResolution = '1080p' }) {
  const resolution = captureResolution === '1440p' ? '2560 x 1440' : '1920 x 1080'

  return (
    <div className="max-w-3xl text-text-secondary">
      <div className="border-b border-border bg-bg-primary px-5 py-4">
        <p className="text-sm text-text-primary">League Replay Studio records discrete clips through OBS Start/Stop Recording. OBS Replay Buffer is not used for scripted capture.</p>
      </div>

      <GuideSection icon={Network} title="OBS WebSocket Control">
        <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-5">
          <li>In OBS, open <span className="font-medium text-text-primary">Tools &gt; WebSocket Server Settings</span>.</li>
          <li>Enable the WebSocket server, use port <span className="font-medium text-text-primary">4455</span>, and set a password.</li>
          <li>In LRS, choose <span className="font-medium text-text-primary">OBS Studio</span>, then select <span className="font-medium text-text-primary">WebSocket</span> in Capture Software.</li>
          <li>Enter the same host, port, and password in <span className="font-medium text-text-primary">Settings &gt; Camera Defaults</span>.</li>
        </ol>
        <p className="mt-3 text-xxs text-text-tertiary">LRS shows a green availability state only after OBS accepts the authenticated control connection.</p>
      </GuideSection>

      <GuideSection icon={Video} title="Recording Output">
        <SettingRows rows={[
          ['Path', 'Settings > Output'],
          ['Output Mode', 'Advanced'],
          ['Recording tab', 'Select Recording'],
          ['Recording Path', outputDirectory || 'Use the LRS Capture Output Directory'],
          ['Recording Format', 'MPEG-4 (.mp4)'],
        ]} />
        <p className="mt-3 text-xxs text-text-tertiary">The OBS recording path must match LRS’s Capture Output Directory so each completed file can be collected, renamed, and validated.</p>
      </GuideSection>

      <GuideSection icon={Cpu} title="RTX 50-Series Encoder">
        <SettingRows rows={[
          ['Video Encoder', 'NVIDIA NVENC AV1'],
          ['Rate Control', 'CQP'],
          ['CQ Level', '18 (use 16 for very high-motion scenes)'],
          ['Keyframe Interval', '2 s'],
          ['Preset', 'P6: Slower (Better Quality)'],
          ['Tuning', 'High Quality'],
          ['Multipass Mode', 'Two Passes (Quarter Resolution)'],
          ['Profile', 'main'],
        ]} />
      </GuideSection>

      <GuideSection icon={Monitor} title="Video Resolution And Frame Rate">
        <SettingRows rows={[
          ['Path', 'Settings > Video'],
          ['Base (Canvas) Resolution', resolution],
          ['Output (Scaled) Resolution', resolution],
          ['Common FPS Values', '60 (use 30 if recording causes dropped frames)'],
        ]} />
        <p className="mt-3 text-xxs text-text-tertiary">Match these OBS dimensions to the Capture Resolution selected in LRS. LRS resizes the iRacing target before capture begins.</p>
      </GuideSection>

      <GuideSection icon={EyeOff} title="Reduce OBS Overhead">
        <p className="text-xs leading-5">After confirming your iRacing source is framed correctly, right-click the OBS preview and disable <span className="font-medium text-text-primary">Enable Preview</span>. This removes the unnecessary visual mirror while recording.</p>
      </GuideSection>
    </div>
  )
}
