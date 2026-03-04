# OurStory — Phase 1 Bootstrap Worklog
*Started: 2026-03-01*

## Plan

Initialize the OurStory project, create a GitHub repo, set up DB infrastructure with Classical Antiquity seed data (500 BCE – 500 CE), and build the Phase 1 frontend.

---

## Steps

### Step 1: Repo & Project Structure
- [x] Git init in `/Users/kdhillon/Documents/Claude/history`
- [x] Create GitHub repo `ourstory` (public) — https://github.com/kdhillon/ourstory
- [x] Create `.gitignore`
- [x] Create `README.md`

### Step 2: Docker Compose
- [x] `docker-compose.yml` — Postgres 16
- [x] `.env.example`

### Step 3: Database Schema
- [x] `db/migrations/001_initial_schema.sql` — cities + events tables, constraints, indexes

### Step 4: Seed Data — Classical Antiquity (500 BCE – 500 CE)
- [x] `db/seeds/001_classical_antiquity.sql` — 8 cities, 15 events inserted

### Step 5: Export Script
- [x] `scripts/package.json`
- [x] `scripts/export-geojson.ts` — wrote 23 features to `frontend/src/data/seed.geojson`

### Step 6: Frontend
- [x] Vite + React + TypeScript scaffold
- [x] `src/types/index.ts`
- [x] `src/types/geojson.d.ts` — module declaration for `.geojson` imports
- [x] `src/theme/categories.ts`
- [x] `src/hooks/useTimeline.ts`
- [x] `src/components/MapView.tsx`
- [x] `src/components/TimelineBar.tsx`
- [x] `src/components/InfoPanel.tsx`
- [x] `src/components/CategoryFilter.tsx`
- [x] `src/App.tsx`
- [x] `vite.config.ts` — inline `.geojson` plugin
- [x] Build passes (`npm run build` ✓)

### Step 7: GitHub Push
- [x] Initial commit + push (commit d46c2d9)

---

## Progress Log

### 2026-03-01 — Phase 1 complete
All steps done. Postgres running in Docker with 8 cities and 15 events seeded. Frontend builds clean. Run `cd frontend && npm run dev` to launch at localhost:5173.

**Known issue**: `node_modules/` for `frontend/` and `scripts/` are not gitignored at the root level (each package has its own `.gitignore`). Fine for now.

**Next up**: Run `npm run dev` and verify the map loads, pins appear, timeline works, info panel opens on click.

