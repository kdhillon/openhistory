# Stories — UX Brainstorm
*Date: 2026-03-03*

---

## The Core Problem

The raw timeline is an *index* — it shows you what happened but not why it mattered or how things connected. A story adds a layer of meaning: it says "watch *these* things, in *this* order, and here's why you should care about each one." The map becomes a stage; the narration is the director.

---

## The Playback Experience

When a story is active, the UI shifts into a different mode. The top nav shrinks or hides. A **narration card** anchors to the bottom of the screen — not a popup, not a sidebar, but a persistent strip that feels like subtitles in a documentary. It shows:

```
┌──────────────────────────────────────────────────────────────────┐
│  Chapter 2 · The Revolution Begins         Step 4 of 12          │
│                                                                   │
│  On July 14, 1789, Parisian crowds stormed the Bastille          │
│  fortress. Though only seven prisoners were inside, the          │
│  symbolic weight was enormous — the monarchy's power             │
│  to imprison without trial had just been defied.                 │
│                                                                   │
│  [Read more ↗]              [◀ Prev]  [▶ Next]  [⏸ Pause]       │
└──────────────────────────────────────────────────────────────────┘
```

The map simultaneously:
- **Flies** to center the current event's location (smooth camera animation)
- **Spotlights** the event's pin with a gentle pulse ring
- **Dims** unrelated events so the relevant one stands out — but doesn't hide them entirely, so you still feel the density of the period

The timeline slider is still visible but locked to the story's current step date. You can see *where* you are in history.

---

## Chapter Structure

A story isn't just a flat list of 40 events — that's overwhelming. It's organized into **chapters** with thematic names. Each chapter starts with a brief **chapter card** (full-screen overlay for 3 seconds, or tap-to-dismiss):

```
┌─────────────────────────────┐
│                             │
│   Chapter 3                 │
│   "The Terror"              │
│   1793 – 1794               │
│                             │
│   40,000 executions in      │
│   14 months. The Revolution │
│   turns on itself.          │
│                             │
└─────────────────────────────┘
```

This gives the user a mental model before diving into individual events.

---

## Multiple Difficulty Levels

Rather than three completely separate stories, think about a **depth model** where every step has a base version and an extended version:

**Explorer** (casual, 8–12 steps, 2–3 sentences each):
> "The Bastille prison was stormed by Parisian crowds, kicking off the Revolution."

**Student** (curious, 20–30 steps, full paragraph):
> "The Bastille's fall on July 14 was more symbolic than strategic — only seven inmates were held there. But it represented the breaking of royal arbitrary power (lettres de cachet). The date became France's national holiday."

**Scholar** (serious, 40+ steps, dense context):
> "The journées of July 14 were preceded by Necker's dismissal on July 11, which triggered panic in grain markets. The crowd that marched to the Bastille was motivated as much by the need for gunpowder (stored there) as by revolutionary ideology. Historians debate whether this was a popular uprising or an organized insurrection…"

The same map events are used at all levels — the difference is *which* events are included and *how much* text accompanies each. A beginner story might skip the Thermidorian Reaction entirely; the scholar version includes it as a chapter.

The level selector could be a simple badge on the story card: `● Explorer` `● Student` `● Scholar` — with a note like "~8 min read" vs "~25 min."

---

## Discovery

**Story Library** — a dedicated page (accessible from the top nav) that looks like a Netflix browse row:

```
┌──────────┐ ┌──────────┐ ┌──────────┐
│ [map img]│ │ [map img]│ │ [map img]│
│ French   │ │ Napoleon │ │ Rise of  │
│Revolution│ │          │ │ Islam    │
│ Explorer │ │ Student  │ │ Scholar  │
│ 12 steps │ │ 28 steps │ │ 35 steps │
└──────────┘ └──────────┘ └──────────┘
```

**Contextual entry**: when you're looking at an event in the info panel that belongs to a story (e.g., you clicked on "Storming of the Bastille"), the info panel shows a chip at the bottom:

```
▶ Watch: The French Revolution — Explorer
```

Clicking it launches the story, starting at the step containing that event. This is a really natural discovery moment — you find something interesting, then get offered the guided experience.

---

## Auto-Generation from Existing Data

We already have most of the raw material. Every war has events linked to it via `part_of_qids`. A "Napoleonic Wars" story could be bootstrapped automatically by:

1. Find all events where `part_of_qids` contains the Napoleonic Wars QID
2. Sort by `year_start`
3. Group into chapters by `part_of_qids` sub-groupings (individual campaigns)
4. Auto-populate step text with `wikipedia_summary`

The result wouldn't be polished narration — it'd read like Wikipedia. But it's a starting scaffold that a human (or LLM) edits into actual storytelling. The authoring tool lets you promote auto-generated summaries into real annotations, reorder steps, and choose which events to include or skip.

---

## Data Model (sketch)

```sql
stories (
  id          UUID PRIMARY KEY,
  slug        TEXT UNIQUE,
  title       TEXT,
  description TEXT,        -- shown in the library card
  level       TEXT,        -- 'explorer' | 'student' | 'scholar'
  author      TEXT,
  created_at  TIMESTAMPTZ
)

story_chapters (
  id          UUID PRIMARY KEY,
  story_id    UUID REFERENCES stories(id),
  position    INT,
  title       TEXT,        -- "The Terror"
  date_range  TEXT,        -- "1793 – 1794" (display only)
  summary     TEXT         -- shown on chapter card before first step
)

story_steps (
  id           UUID PRIMARY KEY,
  story_id     UUID REFERENCES stories(id),
  chapter_id   UUID REFERENCES story_chapters(id),
  position     INT,
  feature_id   UUID,        -- nullable; links to an event/polity/location
  feature_type TEXT,        -- 'event' | 'polity' | 'location'
  annotation   TEXT,        -- the narration text for this step
  year         INT,         -- explicit year if no feature linked
  lng          FLOAT,       -- map center override (optional)
  lat          FLOAT
)
```

---

## Key Open Questions

- **Tone**: neutral/encyclopedic (Wikipedia-style) or narrative/opinionated (Ken Burns documentary-style)? The latter is more engaging but harder to scale and attribute.
- **Length per step**: 2 sentences feels too thin; 5 risks losing people. 3–4 is probably right for Explorer.
- **Branching**: should a story ever branch? ("The Revolution succeeded in France — tap here to see what happened in Haiti during the same period.") Powerful but complex.
- **Map behavior**: does the camera stay locked to the current event, or does it animate to show broader context? (e.g., while narrating the Bastille, zoom out to show all of Paris' events that week)
- **Authorship at scale**: hand-authored stories are high quality but slow to produce. LLM-assisted generation + human editing is the likely path.
- **Multiple stories for one topic**: a French Revolution story for kids vs. adults vs. an academic. Do these share steps? Do they live as separate story records or as depth variants of one?
