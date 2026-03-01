# OurStory

An open-source interactive historical atlas. A real-world map with a timeline slider that lets you scroll through human history — watching events unfold and civilizations rise and fall.

Built with MapLibre GL JS, React, TypeScript, and Wikipedia as the source of truth.

## Getting Started

### Prerequisites
- Docker + Docker Compose
- Node.js 20+

### 1. Start the database
```bash
cp .env.example .env
docker compose up -d
```

### 2. Apply schema and seed data
```bash
psql $DATABASE_URL -f db/migrations/001_initial_schema.sql
psql $DATABASE_URL -f db/seeds/001_classical_antiquity.sql
```

### 3. Export seed data to GeoJSON
```bash
cd scripts && npm install
npm run export
```

### 4. Run the frontend
```bash
cd frontend && npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Project Spec
See [ourstory-spec.md](./ourstory-spec.md) for the full project design.
