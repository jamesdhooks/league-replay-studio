/**
 * IsolatedHtmlPreview
 * Renders a full HTML document in a sandboxed iframe so scripts (e.g. the
 * Tailwind runtime) execute in their own document context and styles are
 * fully isolated from the app shell.
 */
export default function IsolatedHtmlPreview({
  html,
  className = '',
  style = {},
  underlaySrc = null,
  highlightSelector = null,
  highlightNonce = 0,
  zoom = 1,
}) {
  const buildSrcDoc = () => {
    const baseDoc = typeof html === 'string' ? html : ''
    if (!baseDoc) return ''

    try {
      const parser = new DOMParser()
      const doc = parser.parseFromString(baseDoc, 'text/html')
      const head = doc.head || doc.createElement('head')
      const body = doc.body || doc.createElement('body')

      if (!doc.head) doc.documentElement.prepend(head)
      if (!doc.body) doc.documentElement.appendChild(body)

      // Add runtime styles (must be done regardless of restructuring)
      let styleEl = doc.querySelector('#lrs-iframe-overlay-runtime')
      if (!styleEl) {
        styleEl = doc.createElement('style')
        styleEl.id = 'lrs-iframe-overlay-runtime'
        styleEl.textContent = `
          * { box-sizing: border-box; }
          :root {
            background: transparent !important;
            background-color: transparent !important;
          }
          html, body { 
            margin: 0; 
            padding: 0; 
            width: 100%; 
            height: 100%; 
            overflow: hidden;
            background: transparent !important;
            background-color: transparent !important;
            zoom: ${zoom};
            transform-origin: top left;
          }
          .lrs-stream-underlay { position: fixed; inset: 0; z-index: 0; pointer-events: none; background: transparent; }
          .lrs-stream-underlay > img { width: 100%; height: 100%; object-fit: contain; display: block; }
          .lrs-ai-highlight-target {
            outline: 3px solid rgba(250, 204, 21, 0.95) !important;
            box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.18), 0 0 30px rgba(250, 204, 21, 0.85) !important;
            transition: outline-color 120ms ease;
            animation: lrs-ai-highlight-pulse 900ms ease-out 1;
          }
          @keyframes lrs-ai-highlight-pulse {
            0% { transform: scale(1); }
            40% { transform: scale(1.01); }
            100% { transform: scale(1); }
          }
        `
        head.appendChild(styleEl)
      }

      // If underlay is needed, inject it at the top of body
      if (underlaySrc) {
        const existingUnderlay = doc.querySelector('.lrs-stream-underlay')
        if (!existingUnderlay) {
          const underlay = doc.createElement('div')
          underlay.className = 'lrs-stream-underlay'
          const img = doc.createElement('img')
          img.setAttribute('src', underlaySrc)
          img.setAttribute('alt', 'Live stream underlay')
          underlay.appendChild(img)
          body.insertBefore(underlay, body.firstChild)
        }
      }

      // Add highlight script if needed
      if (highlightSelector && !doc.querySelector('#lrs-iframe-highlight-script')) {
        const script = doc.createElement('script')
        script.id = 'lrs-iframe-highlight-script'
        script.textContent = `(() => {
          const selector = ${JSON.stringify(highlightSelector)};
          const nonce = ${JSON.stringify(highlightNonce)};
          if (!selector && nonce == null) return;
          const clearExisting = () => {
            const prev = document.querySelectorAll('.lrs-ai-highlight-target');
            prev.forEach((node) => node.classList.remove('lrs-ai-highlight-target'));
          };
          clearExisting();
          const target = document.querySelector(selector);
          if (!target) return;
          target.classList.add('lrs-ai-highlight-target');
          try { target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch {}
        })();`
        body.appendChild(script)
      }

      return '<!DOCTYPE html>' + doc.documentElement.outerHTML
    } catch {
      return baseDoc
    }
  }

  // Render in a sandboxed iframe so scripts (e.g. Tailwind runtime) execute
  // in their own document context and styles are fully isolated from the app.
  return (
    <iframe
      srcDoc={buildSrcDoc()}
      className={className}
      data-highlight-nonce={highlightNonce}
      allowTransparency="true"
      style={{ ...style, border: 0, background: 'transparent', backgroundColor: 'transparent' }}
      sandbox="allow-scripts allow-same-origin"
      title="overlay-preview"
    />
  )
}
