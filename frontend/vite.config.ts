import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/wikidata-api': {
        target: 'https://www.wikidata.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wikidata-api/, '/w/api.php'),
        // Rewrite cookie domain so the browser stores Wikidata session cookies for localhost
        cookieDomainRewrite: { '.wikidata.org': '', 'wikidata.org': '' },
      },
    },
  },
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
