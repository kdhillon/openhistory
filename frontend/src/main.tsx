import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// StrictMode intentionally omitted — MapLibre GL breaks under React 18 Strict Mode's
// double-invocation of effects (second mount on same container throws canvasContextAttributes).
createRoot(document.getElementById('root')!).render(<App />)
