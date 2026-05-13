import { createRoot } from 'react-dom/client'
import posthog from 'posthog-js'
import './index.css'
import App from './App.tsx'

const posthogKey = import.meta.env.VITE_POSTHOG_KEY
if (posthogKey) {
  posthog.init(posthogKey, {
    api_host: import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com',
    defaults: '2025-05-24',
    person_profiles: 'identified_only',
    capture_pageview: 'history_change',
    capture_pageleave: true,
  })
}

// StrictMode intentionally omitted — MapLibre GL breaks under React 18 Strict Mode's
// double-invocation of effects (second mount on same container throws canvasContextAttributes).
createRoot(document.getElementById('root')!).render(<App />)
