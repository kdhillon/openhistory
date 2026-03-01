import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    // Treat .geojson files as JSON modules
    {
      name: 'geojson',
      transform(code, id) {
        if (id.endsWith('.geojson')) return `export default ${code}`;
      },
    },
  ],
})
