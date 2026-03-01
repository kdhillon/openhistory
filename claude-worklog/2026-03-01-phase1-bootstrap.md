# OurStory — Phase 1 Bootstrap Worklog
*Started: 2026-03-01*

## Plan

Initialize the OurStory project, create a GitHub repo, set up DB infrastructure with Classical Antiquity seed data (500 BCE – 500 CE), and build the Phase 1 frontend.

---

## Steps

### Step 1: Repo & Project Structure
- [ ] Git init in `/Users/kdhillon/Documents/Claude/history`
- [ ] Create GitHub repo `ourstory` (public)
- [ ] Create `.gitignore`
- [ ] Create `README.md`

### Step 2: Docker Compose
- [ ] `docker-compose.yml` — Postgres 16
- [ ] `.env.example`

### Step 3: Database Schema
- [ ] `db/migrations/001_initial_schema.sql` — cities + events tables, constraints, indexes

### Step 4: Seed Data — Classical Antiquity (500 BCE – 500 CE)
- [ ] `db/seeds/001_classical_antiquity.sql` — 8 cities, 15 events

### Step 5: Export Script
- [ ] `scripts/package.json`
- [ ] `scripts/export-geojson.ts` — DB → `frontend/src/data/seed.geojson`

### Step 6: Frontend
- [ ] Vite + React + TypeScript scaffold
- [ ] `src/types/index.ts`
- [ ] `src/theme/categories.ts`
- [ ] `src/hooks/useTimeline.ts`
- [ ] `src/components/MapView.tsx`
- [ ] `src/components/TimelineBar.tsx`
- [ ] `src/components/InfoPanel.tsx`
- [ ] `src/components/CategoryFilter.tsx`
- [ ] `src/App.tsx`

### Step 7: GitHub Push
- [ ] Initial commit + push

---

## Progress Log

