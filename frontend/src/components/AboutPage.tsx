interface Props {
  onBack: () => void;
}


export function AboutPage({ onBack }: Props) {
  return (
    <div style={styles.page}>
      <div style={styles.container}>

        {/* Header */}
        <div style={styles.header}>
          <button style={styles.backBtn} onClick={onBack}>← Back to map</button>
        </div>

        <h1 style={styles.h1}>OpenHistory</h1>
        <p style={styles.lead}>
          An open-source interactive atlas of human history.
        </p>

        <hr style={styles.rule} />

        <h2 style={styles.h2}>Data Sources</h2>

        <h3 style={styles.h3}>Territory Boundaries — OpenHistoricalMap</h3>
        <p style={styles.p}>
          Territory boundaries (the shaded regions on the map) come from{' '}
          <a style={styles.a} href="https://www.openhistoricalmap.org" target="_blank" rel="noreferrer">OpenHistoricalMap</a>{' '}
          (OHM), a community-driven project that maps historical boundaries with day-level precision (CC0).
          A territory is linked to a polity when its OHM relation carries a{' '}
          <code>wikidata=Q…</code> tag pointing at the matching Wikidata entity — when that link
          exists, the boundary, the label, and the polity card all refer to the same entity, and
          colors propagate across the parent hierarchy.
        </p>

        <p style={styles.p}>
          Anyone can contribute boundary edits directly on the OHM website, and they will appear here
          automatically. See below for how to tag a territory's polity link from inside OpenHistory.
        </p>

        <h3 style={styles.h3}>Events, Locations &amp; Polities — Wikipedia / Wikidata</h3>
        <p style={styles.p}>
          The ground truth for all events, locations, and political entities (polities) is{' '}
          <a style={styles.a} href="https://www.wikipedia.org" target="_blank" rel="noreferrer">Wikipedia</a> and its
          structured data layer,{' '}
          <a style={styles.a} href="https://www.wikidata.org" target="_blank" rel="noreferrer">Wikidata</a> (CC BY-SA).
          Our pipeline queries the Wikidata SPARQL API to fetch:
        </p>
        <ul style={styles.ul}>
          <li><strong>Events</strong> — battles, elections, treaties, disasters, discoveries, and more, each with a date and location</li>
          <li><strong>Locations</strong> — cities, regions, and countries referenced by events</li>
          <li><strong>Polities</strong> — kingdoms, empires, republics, colonies, viceroyalties, indigenous nations, peoples, and other political entities. They may have founding and dissolution dates and a capital, and can be assigned to a territory.</li>
        </ul>

        <hr style={styles.rule} />

        <h2 style={styles.h2}>Contributing Data</h2>

        <h3 style={styles.h3}>Editing Events, Locations &amp; Polities</h3>
        <p style={styles.p}>
          When you correct a date or location for an event, location, or polity, that change is
          submitted <strong>directly to Wikidata</strong> — it improves the source data for everyone,
          not just OpenHistory. To make edits you need a free{' '}
          <a style={styles.a} href="https://www.mediawiki.org/wiki/Special:CreateAccount" target="_blank" rel="noreferrer">Wikipedia / Wikimedia account</a>.
          Click any event or polity on the map, then use the edit button in the info panel to
          log in and submit a correction.
        </p>

        <h3 style={styles.h3}>Tagging Territories with their Polity</h3>
        <p style={styles.p}>
          A territory appears in <strong>grey</strong> when its OHM boundary isn't yet tagged
          with a Wikidata QID. The fix lives on OpenHistoricalMap itself — add a{' '}
          <code>wikidata=Q…</code> tag to the relation and OpenHistory will pick it up on the
          next tile refresh. Steps:
        </p>
        <ol style={{ ...styles.ul, paddingLeft: 26 }}>
          <li>Find the territory on{' '}
            <a style={styles.a} href="https://www.openhistoricalmap.org" target="_blank" rel="noreferrer">openhistoricalmap.org</a>{' '}
            and open it in the iD editor
          </li>
          <li>Look up the matching Wikidata entity (e.g. on{' '}
            <a style={styles.a} href="https://www.wikidata.org" target="_blank" rel="noreferrer">wikidata.org</a>) to get its Q-ID
          </li>
          <li>Add a <code>wikidata</code> tag with that Q-ID to the OHM relation, and save</li>
        </ol>
        <p style={styles.p}>
          You'll need a free{' '}
          <a style={styles.a} href="https://www.openhistoricalmap.org/user/new" target="_blank" rel="noreferrer">OpenHistoricalMap account</a>{' '}
          (OSM-style login). An in-app one-click tagging flow is planned but not live yet.
        </p>

        <h3 style={styles.h3}>Editing Territory Boundaries</h3>
        <p style={styles.p}>
          Boundary <em>shapes</em> (where a territory's edges lie) are edited on OpenHistoricalMap
          itself — they're not stored in OpenHistory. Open the territory on{' '}
          <a style={styles.a} href="https://www.openhistoricalmap.org" target="_blank" rel="noreferrer">openhistoricalmap.org</a>{' '}
          in OHM's iD editor and adjust the polygon vertices. Edits propagate to OpenHistory on
          OHM's next tile refresh.
        </p>

        <hr style={styles.rule} />

        <h2 style={styles.h2}>How Coloring Works</h2>

        <h3 style={styles.h3}>Capital city as the base signal</h3>
        <p style={styles.p}>
          A polity's color is hashed from its <strong>capital city's Wikidata QID</strong>
          (with the polity's name as a fallback when no capital is recorded). Two entities
          centred on the same city share a color — so <strong>Spain</strong>,{' '}
          <strong>Spanish Empire</strong>, and the <strong>Crown of Castile</strong> all
          share Madrid and render in the same color.
        </p>

        <h3 style={styles.h3}>Children inherit their parent's color</h3>
        <p style={styles.p}>
          Most polities are part of a larger umbrella entity at some point in their lifetime —
          Saxony was part of the German Confederation 1815-1866, then part of the German Empire
          1871-1918.
        </p>
        <p style={styles.p}>
          When you scrub the timeline to a year where a polity has an active parent, the child
          renders in the <strong>parent's color</strong> instead of its own. So all German
          Confederation members at 1820 — Saxony, Hesse, Hanover, Württemberg, etc. — render
          in one shared color (the Confederation's), making the political grouping visible at
          a glance.
        </p>

        <h3 style={styles.h3}>Where parent links come from</h3>
        <p style={styles.p}>
          Parent relationships are read from Wikidata, using five properties combined: <code>P150</code>{' '}
          (contains administrative entity), <code>P361</code> (part of), <code>P131</code>{' '}
          (located in administrative entity), <code>P17</code> (country), and <code>P127</code>{' '}
          (owned by). Each link's year range is intersected with both the parent's and child's
          own lifetimes so the relationship is temporally accurate.
        </p>
        <p style={styles.p}>
          More technical detail in{' '}
          <a style={styles.a} href="https://github.com/kdhillon/openhistory/blob/main/docs/polity-parent-coloring.md" target="_blank" rel="noreferrer">docs/polity-parent-coloring.md</a>.
        </p>

        <hr style={styles.rule} />

        <h2 style={styles.h2}>License</h2>
        <p style={styles.p}>
          OpenHistory is fully open source under the MIT license. The code, pipeline, and data
          schema are all public.
        </p>
        <a
          style={styles.githubBtn}
          href="https://github.com/kdhillon/openhistory"
          target="_blank"
          rel="noreferrer"
        >
          View on GitHub
        </a>

        <h2 style={styles.h2}>Issues &amp; Contributions</h2>
        <p style={styles.p}>
          Found a bug or have a feature idea? Open an issue or pull request on{' '}
          <a style={styles.a} href="https://github.com/kdhillon/openhistory/issues" target="_blank" rel="noreferrer">GitHub</a>.
        </p>

        <h2 style={styles.h2}>Contact</h2>
        <p style={styles.p}>
          To get in touch for promotion or collaboration, reach me at kyle [at] openhistory.app.
        </p>

        <hr style={styles.rule} />
        <p style={styles.footer}>
          Event &amp; polity data © <a style={styles.a} href="https://www.wikidata.org" target="_blank" rel="noreferrer">Wikidata</a> contributors (CC BY-SA) ·{' '}
          Territory boundaries © <a style={styles.a} href="https://www.openhistoricalmap.org" target="_blank" rel="noreferrer">OpenHistoricalMap</a> contributors (CC0) ·{' '}
          Map © <a style={styles.a} href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> ·{' '}
          Code © 2026 OpenHistory contributors (MIT) ·{' '}
          Created by <a style={styles.a} href="https://github.com/KDhillon" target="_blank" rel="noreferrer">Kyle Dhillon</a>
        </p>

      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    // body has overflow:hidden globally (for the map view), so the About page
    // needs its own scroll container — height:100vh + overflow-y:auto.
    height: '100vh',
    overflowY: 'auto',
    background: '#f8f9fa',
    display: 'flex',
    justifyContent: 'center',
    padding: '40px 20px 80px',
  },
  container: {
    maxWidth: 680,
    width: '100%',
  },
  header: {
    marginBottom: 32,
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#3366cc',
    fontSize: 14,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
  h1: {
    fontSize: 36,
    fontWeight: 700,
    color: '#202122',
    margin: '0 0 12px',
    letterSpacing: '-0.02em',
  },
  lead: {
    fontSize: 17,
    color: '#54595d',
    lineHeight: 1.6,
    margin: '0 0 16px',
  },
  statusBadge: {
    display: 'inline-block',
    background: '#fff3cd',
    border: '1px solid #ffc107',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 13,
    color: '#664d03',
    marginBottom: 24,
  },
  rule: {
    border: 'none',
    borderTop: '1px solid rgba(0,0,0,0.1)',
    margin: '28px 0',
  },
  h2: {
    fontSize: 22,
    fontWeight: 600,
    color: '#202122',
    margin: '28px 0 10px',
    letterSpacing: '-0.01em',
  },
  h3: {
    fontSize: 16,
    fontWeight: 600,
    color: '#202122',
    margin: '20px 0 8px',
  },
  p: {
    fontSize: 15,
    color: '#202122',
    lineHeight: 1.7,
    margin: '0 0 14px',
  },
  ul: {
    fontSize: 15,
    color: '#202122',
    lineHeight: 1.9,
    paddingLeft: 22,
    margin: '0 0 14px',
  },
  a: {
    color: '#3366cc',
    textDecoration: 'none',
  },
  githubBtn: {
    display: 'inline-block',
    background: '#202122',
    color: '#ffffff',
    padding: '9px 18px',
    borderRadius: 7,
    fontSize: 14,
    fontWeight: 600,
    textDecoration: 'none',
    marginBottom: 24,
  },
  footer: {
    fontSize: 13,
    color: '#54595d',
    lineHeight: 1.7,
    margin: 0,
  },
};
