import { useState, useEffect, useCallback, useRef } from 'react';
import type { FeatureProperties, Category, PolityType, StoryIndexEntry } from '../types';
import type { StackInfo } from './MapView';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../theme/categories';
import { CATEGORY_SVGS, colorSvg, svgDataUri } from '../theme/icons';
import { displayYear, encodeDate, decodeDate, STEP_DAY, STEP_MONTH, STEP_YEAR } from '../hooks/useTimeline';
import { WikiEditForm } from './WikiEditForm';
import { fetchArticleInLanguage } from '../lib/wikidataApi';
import { useWikidataEntity } from '../hooks/useWikidataEntity';
import { LANG_CODE_TO_NAME } from '../lib/languages';
import { patchFeature, patchPolity, searchOhm } from '../lib/api';
import { EVENT_CATEGORIES, POLITY_CATEGORIES } from '../theme/categories';
import { getPolityColorAtYear, activeParentAt, isValidPaletteId, DEFAULT_PALETTE_ID } from '../theme/polityPalettes';
import type { PaletteId, PolityForColor, ParentEntry } from '../theme/polityPalettes';

interface WikiSection {
  title: string;
  index: number;
  level: number;
}

interface WikiArticle {
  wikiTitle: string;
  apiBase: string;
  lang: string;
  images: string[];
  leadHtml: string;
  sections: WikiSection[];
}

interface Props {
  feature: FeatureProperties | null;
  stack: StackInfo;
  onClose: () => void;
  geojson?: GeoJSON.FeatureCollection;
  onNavigateToFeature?: (f: FeatureProperties) => void;
  wikiAuth: string | null;
  onAuth: (username: string | null) => void;
  onFeatureUpdated: (updates: Partial<FeatureProperties>) => void;
  hiddenNations?: Map<string, number>;
  onToggleHiddenNation?: (polityId: string) => void;
  onHideFeature?: (id: string, type: 'polity' | 'event') => void;
  selectedLang?: string;
  onStartStory?: (slug: string) => void;
  isMobile?: boolean;
  /** Current timeline year as YYYYMMDD — used to filter polity parents to those active at this year. */
  currentDateInt: number;
  /** Whether this polity is already mapped to an OHM territory (via ohmLinks or auto-match). */
  isOhmMapped?: boolean;
  /** Enter placement mode: user clicks map to place a label for this polity. */
  onAddToOhm?: (feature: FeatureProperties) => void;
  /** Open the OHM mapping modal for the OHM element this feature came from (when known). */
  onEditOhm?: (ctx: { osmType: 'relation' | 'node'; osmId: number; name: string; currentQid: string | null; yearStart: number | null; yearEnd: number | null }) => void;
}

function wikiApi(lang: string) {
  return `https://${lang}.wikipedia.org/w/api.php`;
}

function wikiParams(p: Record<string, string>): string {
  return new URLSearchParams({ format: 'json', origin: '*', ...p }).toString();
}

function fixWikiHtml(html: string, lang = 'en'): string {
  return html
    .replace(
      /href="(\/wiki\/[^"#]+)"/g,
      `target="_blank" rel="noopener noreferrer" href="https://${lang}.wikipedia.org$1"`,
    )
    .replace(/src="\/\/([^"]+)"/g, 'src="https://$1"')
    .replace(/srcset="\/\/([^"]+)"/g, 'srcset="https://$1"');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function MissingWikiNote({ qid, onEdit }: { qid: string; onEdit?: () => void }) {
  // When we know which OHM element this feature came from (onEdit provided),
  // clicking "Open Historical Map" opens the OHM mapping modal — the user
  // picks a different polity and the new wikidata tag is pushed straight to
  // OHM via the API. Without that context, fall back to deep-linking OHM's
  // iD editor at the current map view.
  const zoom = Math.max(15, Math.round(Number(localStorage.getItem('oh-map-zoom') ?? '5')));
  const lat = Number(localStorage.getItem('oh-map-lat') ?? '30').toFixed(4);
  const lng = Number(localStorage.getItem('oh-map-lng') ?? '0').toFixed(4);
  const ohmUrl = `https://www.openhistoricalmap.org/edit#map=${zoom}/${lat}/${lng}`;
  const linkStyle: React.CSSProperties = { color: '#3366cc', textDecoration: 'none' };
  return (
    <p style={{
      fontSize: 12.5,
      color: '#7a8aa0',
      fontStyle: 'italic',
      margin: 0,
      padding: '14px 16px 0',
      lineHeight: 1.5,
    }}>
      No English Wikipedia article linked for{' '}
      <a
        href={`https://www.wikidata.org/wiki/${qid}`}
        target="_blank"
        rel="noreferrer"
        style={linkStyle}
      >{qid}</a>.{' '}
      If this is the incorrect Wikidata ID, you can correct it on{' '}
      {onEdit ? (
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); onEdit(); }}
          style={linkStyle}
        >Open Historical Map</a>
      ) : (
        <a
          href={ohmUrl}
          target="_blank"
          rel="noreferrer"
          style={linkStyle}
        >Open Historical Map</a>
      )}.
    </p>
  );
}

function PencilIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" style={{ display: 'block' }}>
      <path d="M8.5 1.5l2 2-7 7H1.5v-2l7-7z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function InfoPanel({ feature: rawFeature, stack, onClose, geojson, onNavigateToFeature, wikiAuth, onAuth, onFeatureUpdated, hiddenNations, onToggleHiddenNation, onHideFeature, selectedLang = 'en', onStartStory, isMobile, currentDateInt, isOhmMapped, onAddToOhm, onEditOhm }: Props) {
  // Live-fetch Wikidata when either:
  //   (a) the feature is a Wikidata stub (synthesized in MapView for OHM polygons
  //       with no matching local feature — id starts with `wd:`), or
  //   (b) it's a local feature with a wikidataQid but no Wikipedia data cached
  //       (e.g. our polity row exists but no wikipedia_url/summary in seed.geojson).
  // Either way we overlay the fetched fields onto the rawFeature so the panel
  // renders consistently. Local-DB fields (title, etc.) take precedence; live data
  // only fills gaps.
  const isWikidataStub = rawFeature?.id?.startsWith('wd:') ?? false;
  const needsLiveFetch = !!(rawFeature?.wikidataQid && !rawFeature.wikipediaSummary && !rawFeature.wikipediaUrl);
  const fetchQid = (isWikidataStub || needsLiveFetch) ? rawFeature?.wikidataQid ?? null : null;
  const { data: liveEntity } = useWikidataEntity(fetchQid, selectedLang);
  const feature: FeatureProperties | null = (rawFeature && fetchQid && liveEntity)
    ? {
        ...rawFeature,
        title: rawFeature.title || liveEntity.title,
        wikipediaSummary: rawFeature.wikipediaSummary || liveEntity.summary,
        wikipediaUrl: rawFeature.wikipediaUrl || liveEntity.wikipediaUrl,
        yearStart: rawFeature.yearStart ?? liveEntity.yearStart,
        yearEnd: rawFeature.yearEnd ?? liveEntity.yearEnd,
      }
    : rawFeature;
  // True when the entity has a QID but no English Wikipedia article is linked
  // from Wikidata (either because no `enwiki` sitelink exists, or because the
  // resolved URL points to Wikidata itself). Surfaced as a hint so the user can
  // fix it upstream rather than working around it client-side.
  const missingEnglishWiki = !!(
    feature?.wikidataQid &&
    (!feature.wikipediaUrl || /wikidata\.org/.test(feature.wikipediaUrl))
  );
  // When the feature came from an OHM tile click, we know which relation/node
  // it's linked to and can push tag edits directly via the API. Otherwise the
  // MissingWikiNote falls back to a deep-link to OHM's iD editor.
  const ohmEditHandler = (onEditOhm && feature?._ohmOsmType && feature?._ohmOsmId)
    ? () => onEditOhm({
        osmType: feature._ohmOsmType as 'relation' | 'node',
        osmId: feature._ohmOsmId as number,
        name: feature.title ?? '',
        currentQid: feature.wikidataQid ?? null,
        yearStart: feature.yearStart ?? null,
        yearEnd: feature.yearEnd ?? null,
      })
    : undefined;
  const [expanded, setExpanded] = useState(false);
  const [expandedWidth, setExpandedWidth] = useState(468);
  const [editField, setEditField] = useState<'date' | 'location' | 'capital' | null>(null);
  const [capitalDraft, setCapitalDraft] = useState<{ name: string; lat: string; lng: string } | null>(null);
  const [capitalSaving, setCapitalSaving] = useState(false);
  const [article, setArticle] = useState<WikiArticle | null>(null);
  const [loading, setLoading] = useState(false);
  const [openSections, setOpenSections] = useState<Set<number>>(new Set());
  const [sectionHtml, setSectionHtml] = useState<Map<number, string>>(new Map());
  const [loadingSections, setLoadingSections] = useState<Set<number>>(new Set());
  const [imageIndex, setImageIndex] = useState(0);
  const [imageExpanded, setImageExpanded] = useState(false);
  const [showImages, setShowImages] = useState(!isMobile);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [categorySaving, setCategorySaving] = useState(false);

  const [storyIndex, setStoryIndex] = useState<StoryIndexEntry[]>([]);

  // Collapse photos when the edit form opens
  useEffect(() => {
    if (editField) setShowImages(false);
  }, [editField]);

  // Load story index once
  useEffect(() => {
    fetch('/data/stories/index.json')
      .then((r) => r.ok ? r.json() : [])
      .then((data: StoryIndexEntry[]) => setStoryIndex(data))
      .catch(() => {});
  }, []);

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const categoryPickerRef = useRef<HTMLDivElement>(null);

  // Close category picker on outside click
  useEffect(() => {
    if (!categoryPickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (categoryPickerRef.current && !categoryPickerRef.current.contains(e.target as Node)) {
        setCategoryPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [categoryPickerOpen]);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: expandedWidth };
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const newWidth = Math.max(320, Math.min(900, dragRef.current.startWidth + (dragRef.current.startX - ev.clientX)));
      setExpandedWidth(newWidth);
    };

    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [expandedWidth]);

  // Reset everything when a different feature is selected
  const [fetchedSummary, setFetchedSummary] = useState<string | null>(null);

  // Translated title + summary for non-English languages
  const [translatedContent, setTranslatedContent] = useState<{ title: string; wikiTitle: string; summary: string; hasArticle: boolean } | null>(null);
  const [translating, setTranslating] = useState(false);

  useEffect(() => {
    setExpanded(true);
    setArticle(null);
    setLoading(false);
    setFetchedSummary(null);
    setTranslatedContent(null);
    setOpenSections(new Set());
    setSectionHtml(new Map());
    setLoadingSections(new Set());
    setImageIndex(0);
    setImageExpanded(false);
    setEditField(null);
    setCapitalDraft(null);
    setCategoryPickerOpen(false);
  }, [feature?.title]);

  // Reset article when language changes so it re-fetches in the new language
  useEffect(() => {
    setArticle(null);
    setOpenSections(new Set());
    setSectionHtml(new Map());
  }, [selectedLang]);

  // Fetch translation when language or feature changes
  useEffect(() => {
    const qid = feature?.wikidataQid;
    console.log(`[i18n] effect: qid=${qid ?? '∅'} lang=${selectedLang} title=${feature?.title ?? '∅'}`);
    if (!qid || selectedLang === 'en') {
      setTranslatedContent(null);
      return;
    }
    let cancelled = false;
    setTranslating(true);
    setTranslatedContent(null);
    fetchArticleInLanguage(qid, selectedLang).then((result) => {
      if (cancelled) return;
      console.log(`[i18n] result for ${qid}/${selectedLang}:`, result);
      setTranslatedContent(result);
      setTranslating(false);
    }).catch((e) => {
      console.warn(`[i18n] fetch threw for ${qid}/${selectedLang}:`, e);
      if (!cancelled) setTranslating(false);
    });
    return () => { cancelled = true; };
  }, [feature?.wikidataQid, selectedLang]);

  // On-demand summary fetch for features with no pre-populated wikipediaSummary
  useEffect(() => {
    if (!feature || feature.wikipediaSummary || !feature.wikipediaUrl) return;
    const match = feature.wikipediaUrl.match(/\/wiki\/([^#?]+)/);
    if (!match) return;
    const title = decodeURIComponent(match[1]);
    fetch(`${wikiApi('en')}?${wikiParams({ action: 'query', titles: title, prop: 'extracts', exintro: '1', explaintext: '1', exsentences: '3' })}`)
      .then((r) => r.json())
      .then((data) => {
        const pages = Object.values(data.query?.pages ?? {}) as Array<{ extract?: string }>;
        const extract = pages[0]?.extract?.trim();
        if (extract) setFetchedSummary(extract);
      })
      .catch(() => {});
  }, [feature?.title]);

  // Fetch lead + section list + thumbnail in parallel on expand
  useEffect(() => {
    if (!expanded || article !== null) return;

    let apiBase: string;
    let pageTitle: string;

    if (selectedLang === 'en') {
      if (!feature?.wikipediaUrl) return;
      // Parse host AND title. wikipediaUrl may point to a non-English wiki (e.g. nlwiki
      // when no English article exists) or to Wikidata directly — only fetch when it's
      // actually the English Wikipedia.
      const urlMatch = feature.wikipediaUrl.match(/^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/([^#?]+)/);
      if (!urlMatch) return; // Wikidata or unsupported host — show summary only
      if (urlMatch[1] !== 'en') return; // foreign-lang wiki — don't try to render
      apiBase = wikiApi('en');
      pageTitle = decodeURIComponent(urlMatch[2]);
    } else {
      // Wait for translatedContent to resolve the sitelink title
      if (!translatedContent?.wikiTitle) return;
      apiBase = wikiApi(selectedLang);
      pageTitle = translatedContent.wikiTitle;
    }

    setLoading(true);
    Promise.all([
      fetch(`${apiBase}?${wikiParams({ action: 'parse', page: pageTitle, section: '0', prop: 'text' })}`).then((r) => r.json()),
      fetch(`${apiBase}?${wikiParams({ action: 'parse', page: pageTitle, prop: 'sections' })}`).then((r) => r.json()),
      fetch(`${apiBase}?${wikiParams({ action: 'query', generator: 'images', titles: pageTitle, prop: 'imageinfo', iiprop: 'url|size|mime', iiurlwidth: '800', gimlimit: '30' })}`).then((r) => r.json()),
    ])
      .then(([leadRes, sectionsRes, imagesRes]) => {
        const leadHtml = fixWikiHtml(leadRes.parse?.text?.['*'] ?? '', selectedLang);
        const sections: WikiSection[] = (sectionsRes.parse?.sections ?? []).map(
          (s: { line?: string; index?: string; toclevel?: number }) => ({
            title: stripHtml(String(s.line ?? '')),
            index: Number(s.index ?? 0),
            level: Number(s.toclevel ?? 1),
          }),
        );
        type ImgPage = { imageinfo?: Array<{ url?: string; thumburl?: string; width?: number; mime?: string }> };
        const imgPages = Object.values(imagesRes?.query?.pages ?? {}) as ImgPage[];
        const images = imgPages
          .filter((p) => {
            const ii = p.imageinfo?.[0];
            if (!ii) return false;
            const mime = ii.mime ?? '';
            return mime.startsWith('image/') && mime !== 'image/svg+xml' && (ii.width ?? 0) >= 300;
          })
          .map((p) => p.imageinfo![0].thumburl ?? p.imageinfo![0].url ?? '')
          .filter(Boolean);
        setArticle({ wikiTitle: pageTitle, apiBase, lang: selectedLang, images, leadHtml, sections });
      })
      .catch(() => {
        setArticle({ wikiTitle: pageTitle, apiBase, lang: selectedLang, images: [], leadHtml: '<p>Could not load article.</p>', sections: [] });
      })
      .finally(() => setLoading(false));
  }, [expanded, feature?.wikipediaUrl, article, selectedLang, translatedContent]);

  // Auto-open and pre-fetch the "History" section when article first loads
  useEffect(() => {
    if (!article || article.sections.length === 0) return;
    const history = article.sections.find((s) => s.title.toLowerCase() === 'history');
    if (!history) return;

    setOpenSections((prev) => new Set(prev).add(history.index));
    setLoadingSections((prev) => new Set(prev).add(history.index));
    fetch(`${article.apiBase}?${wikiParams({ action: 'parse', page: article.wikiTitle, section: String(history.index), prop: 'text' })}`)
      .then((r) => r.json())
      .then((data) => {
        setSectionHtml((prev) => new Map(prev).set(history.index, fixWikiHtml(data.parse?.text?.['*'] ?? '', article.lang)));
      })
      .catch(() => {
        setSectionHtml((prev) => new Map(prev).set(history.index, '<p>Could not load section.</p>'));
      })
      .finally(() => {
        setLoadingSections((prev) => { const next = new Set(prev); next.delete(history.index); return next; });
      });
  }, [article]);

  // Intercept wiki-content link clicks — navigate on-map if the article exists in our dataset.
  // For polities and events we navigate in-app. For regions we prefer the polity twin
  // (same wikidataQid) when one exists; if there's no polity twin we don't intercept,
  // since navigating to a region card auto-activates the 'region' category filter
  // (cluttering the map) and that's not what the user wants from a wiki-link click.
  const handleBodyClick = useCallback((e: React.MouseEvent) => {
    if (!geojson || !onNavigateToFeature) return;
    const anchor = (e.target as Element).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    const match = href.match(/\/wiki\/([^#?]+)/);
    if (!match) return;
    const slug = decodeURIComponent(match[1]); // e.g. "Battle_of_Thermopylae"
    const slugSpaces = slug.replace(/_/g, ' ');
    const found = geojson.features.find((f) => {
      const p = f.properties as FeatureProperties;
      return p.wikipediaTitle === slug || p.wikipediaTitle === slugSpaces || p.slug === slug;
    });
    if (!found) return;  // no match → link opens Wikipedia normally
    const foundProps = found.properties as FeatureProperties;

    if (foundProps.featureType === 'region') {
      // Region-only matches: open the polity twin if we have one, else let the link
      // open Wikipedia in a new tab (don't pollute the map with region markers).
      if (!foundProps.wikidataQid) return;
      const twin = geojson.features.find((f) => {
        const p = f.properties as FeatureProperties;
        return p.featureType === 'polity' && p.wikidataQid === foundProps.wikidataQid;
      });
      if (!twin) return;
      e.preventDefault();
      onNavigateToFeature(twin.properties as FeatureProperties);
      return;
    }

    // Polities and events: navigate in-app as before.
    e.preventDefault();
    onNavigateToFeature(foundProps);
  }, [geojson, onNavigateToFeature]);


  if (!feature) return null;

  const primaryColor = CATEGORY_COLORS[feature.primaryCategory as Category] ?? '#9E9E9E';

  // Build date string: null means no known date (permanent locations)
  const isLocation = feature.featureType === 'city' || feature.featureType === 'region';
  const isPolity = feature.featureType === 'polity';

  // Polity-status tag: replaces the polity-type category tag with either
  //   "Part of {parent.title}"  (when the polity has an active parent at currentYear)
  //   "Independent Polity"      (when it doesn't)
  // Also applies to region features that have a polity twin (same wikidataQid) — these
  // are entities like Viceroyalty of Peru that exist in both the locations and polities
  // tables; the region card should still surface the parent relationship.
  type PolityTagInfo =
    | { kind: 'parent'; text: string; color: string; targetFeature: GeoJSON.Feature | null }
    | { kind: 'independent'; color: string; polityType: PolityType | undefined };
  const polityStatusTag: PolityTagInfo | null = (() => {
    if (!isPolity && feature.featureType !== 'region') return null;

    // Find the polity feature to read parents from. For polity features that's the
    // current one; for region features it's the twin in geojson by wikidataQid.
    let polityFeature: FeatureProperties | null = null;
    if (isPolity) {
      polityFeature = feature;
    } else if (feature.wikidataQid && geojson) {
      const twin = geojson.features.find(f => {
        const p = f.properties as FeatureProperties;
        return p.featureType === 'polity' && p.wikidataQid === feature.wikidataQid;
      });
      if (twin) polityFeature = twin.properties as FeatureProperties;
    }
    if (!polityFeature) return null;

    // Defensive parse of parents (matches the partOfResolved handling above).
    const rawParents = polityFeature.parents;
    const parents: ParentEntry[] = Array.isArray(rawParents)
      ? (rawParents as ParentEntry[])
      : typeof rawParents === 'string'
        ? (() => { try { return JSON.parse(rawParents as unknown as string); } catch { return []; } })()
        : [];

    // Strictly use the current timeline year. The parent shown is whichever was
    // active AT THAT YEAR — not at the polity's midpoint or boundary.
    const currentYear = decodeDate(currentDateInt).year;
    const active = parents.filter(p =>
      (p.yearStart == null || p.yearStart <= currentYear) &&
      (p.yearEnd == null || p.yearEnd >= currentYear)
    );
    const rank = (s: string) => s === 'P150' ? 0 : s === 'P361' ? 1 : s === 'P131' ? 2 : s === 'P127' ? 3 : 4;
    active.sort((a, b) => rank(a.source) - rank(b.source));

    // Read the user's chosen palette so the tag color matches the map exactly.
    const savedPalette = localStorage.getItem('oh-polity-palette');
    const paletteId: PaletteId = isValidPaletteId(savedPalette) ? savedPalette : DEFAULT_PALETTE_ID;

    // Build a registry for the cascade resolver from the loaded GeoJSON.
    // Also index by capital so the capital-sibling cascade fallback works when
    // a polity (e.g. Fascist Italy) has no direct parent in Wikidata but shares
    // a capital with one that does.
    const polityByQid: Record<string, PolityForColor> = {};
    const polityByCapital: Record<string, PolityForColor[]> = {};
    if (geojson) {
      for (const f of geojson.features) {
        const p = f.properties as FeatureProperties;
        if (p.featureType !== 'polity' || !p.wikidataQid) continue;
        if (!polityByQid[p.wikidataQid]) {
          const pfc: PolityForColor = {
            qid: p.wikidataQid,
            polityType: p.polityType,
            parents: p.parents,
            // Hash by capital QID for semantic color grouping (Spain ≈ Spanish Empire).
            polityKey: p.capitalWikidataQid ?? p.title,
            capitalName: p.capitalName ?? null,
            yearStart: p.yearStart ?? null,
            yearEnd: p.yearEnd ?? null,
          };
          polityByQid[p.wikidataQid] = pfc;
          if (p.capitalName) {
            const key = p.capitalName.toLowerCase();
            (polityByCapital[key] ??= []).push(pfc);
          }
        }
      }
    }
    const resolveByQid = (qid: string): PolityForColor | null => polityByQid[qid] ?? null;
    const findCapitalSibling = (capitalName: string, year: number, excludeQid: string): PolityForColor | null => {
      const candidates = polityByCapital[capitalName.toLowerCase()];
      if (!candidates) return null;
      const activeC = candidates.filter((c) =>
        c.qid !== excludeQid &&
        (c.yearStart == null || c.yearStart <= year) &&
        (c.yearEnd == null || c.yearEnd >= year)
      );
      if (activeC.length === 0) return null;
      const withParent = activeC.filter((c) => activeParentAt(c.parents, year));
      const pool = withParent.length > 0 ? withParent : activeC;
      pool.sort((a, b) => (a.yearStart ?? 0) - (b.yearStart ?? 0));
      return pool[0];
    };

    // Find the first active parent that is in our registry — that's the one we display.
    let parentFeature: GeoJSON.Feature | null = null;
    let parentTitle: string | null = null;
    for (const p of active) {
      const pf = geojson?.features.find(f => {
        const props = f.properties as FeatureProperties;
        return props.featureType === 'polity' && props.wikidataQid === p.qid;
      }) ?? null;
      if (pf) {
        parentFeature = pf;
        parentTitle = (pf.properties as FeatureProperties).title ?? p.qid;
        break;
      }
    }

    const selfPolity: PolityForColor = {
      qid: polityFeature.wikidataQid ?? '',
      polityType: polityFeature.polityType,
      parents: parents,
      polityKey: polityFeature.capitalWikidataQid ?? polityFeature.title,
      capitalName: polityFeature.capitalName ?? null,
      yearStart: polityFeature.yearStart ?? null,
      yearEnd: polityFeature.yearEnd ?? null,
    };
    const color = getPolityColorAtYear(selfPolity, currentYear, paletteId, resolveByQid, findCapitalSibling);

    if (parentTitle) {
      return { kind: 'parent', text: `Part of ${parentTitle}`, color, targetFeature: parentFeature };
    }
    // No active parent — render the polity's own category tag (Kingdom / Empire / etc.)
    // but with the cascade-resolved color so the tag matches the map fill exactly.
    return { kind: 'independent', color, polityType: polityFeature.polityType };
  })();
  // Format a raw year/month/day to a display string at the highest available granularity
  const fmtDate = (year: number, month: number | null | undefined, day: number | null | undefined) => {
    const step = day != null ? STEP_DAY : month != null ? STEP_MONTH : STEP_YEAR;
    return displayYear(encodeDate(year, month ?? 1, day ?? 1), step);
  };

  let dateStr: string | null = null;
  const prefix = feature.dateIsFuzzy ? '~' : '';
  if (feature.yearStart != null && feature.yearEnd != null) {
    // Both known — show full range
    dateStr = `${prefix}${fmtDate(feature.yearStart, feature.monthStart, feature.dayStart)} – ${prefix}${fmtDate(feature.yearEnd, feature.monthEnd, feature.dayEnd)}`;
  } else if (feature.yearStart != null) {
    const startStr = `${prefix}${fmtDate(feature.yearStart, feature.monthStart, feature.dayStart)}`;
    // Locations without a known end date: show "– present"
    dateStr = isLocation ? `${startStr} – present` : startStr;
  } else if (feature.yearEnd != null) {
    // Only end date known (some polities/sultanates)
    dateStr = `? – ${prefix}${fmtDate(feature.yearEnd, feature.monthEnd, feature.dayEnd)}`;
  }

  const toggleSection = (section: WikiSection) => {
    const i = section.index;
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(i)) { next.delete(i); return next; }
      next.add(i);
      return next;
    });

    if (!sectionHtml.has(i) && !loadingSections.has(i) && article) {
      setLoadingSections((prev) => new Set(prev).add(i));
      fetch(`${article.apiBase}?${wikiParams({ action: 'parse', page: article.wikiTitle, section: String(i), prop: 'text' })}`)
        .then((r) => r.json())
        .then((data) => {
          setSectionHtml((prev) => new Map(prev).set(i, fixWikiHtml(data.parse?.text?.['*'] ?? '<p>Empty section.</p>', article.lang)));
        })
        .catch(() => {
          setSectionHtml((prev) => new Map(prev).set(i, '<p>Could not load section.</p>'));
        })
        .finally(() => {
          setLoadingSections((prev) => { const next = new Set(prev); next.delete(i); return next; });
        });
    }
  };

  return (
    <div style={{
      ...styles.panel,
      top: isMobile ? 56 : 66,
      width: expanded ? expandedWidth : 360,
      // Extend down to the timeline bar (mobile timeline is 90px, desktop is 64px)
      bottom: isMobile ? 90 : 64,
      height: 'auto',
      maxHeight: 'none',
      overflow: (expanded || isMobile) ? 'hidden' : 'visible',
      transition: dragRef.current ? 'none' : 'width 0.25s ease',
    }}>
      {/* Resize handle — left edge, expanded only */}
      {expanded && (
        <div className="resize-handle" onMouseDown={startDrag} />
      )}
      {/* Accent bar */}
      <div style={{ ...styles.accent, background: primaryColor }} />

      {/* Header */}
      <div style={styles.header}>
        <div style={{ ...styles.headerLeft, position: 'relative' }}>
          {polityStatusTag?.kind === 'parent' ? (
            // "Part of X" tag — replaces the polity-type category tag. Color matches the
            // map render color (parent's color via the cascade).
            (() => {
              const { text, color, targetFeature } = polityStatusTag;
              const clickable = !!(targetFeature && onNavigateToFeature);
              return (
                <span
                  title={clickable ? `Navigate to ${text.replace(/^Part of /, '')}` : undefined}
                  onClick={clickable ? () => onNavigateToFeature!(targetFeature!.properties as FeatureProperties) : undefined}
                  style={{
                    ...styles.tag,
                    background: `${color}22`,
                    color,
                    borderColor: `${color}44`,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    cursor: clickable ? 'pointer' : 'default',
                  }}
                >
                  {text}
                </span>
              );
            })()
          ) : polityStatusTag?.kind === 'independent' ? (
            // No active parent — show the polity's own type label (Kingdom / Empire / etc.)
            // but recolored to match the cascade (which equals its own map color here).
            (() => {
              const cat = (polityStatusTag.polityType ?? 'other') as Category;
              const color = polityStatusTag.color;
              const rawSvg = CATEGORY_SVGS[cat];
              const iconSrc = rawSvg ? svgDataUri(colorSvg(rawSvg, color)) : null;
              const isEditable = feature.featureType === 'event' || feature.featureType === 'polity';
              return (
                <span
                  key={cat}
                  title={isEditable ? 'Click to reassign category' : undefined}
                  onClick={isEditable ? () => setCategoryPickerOpen((v) => !v) : undefined}
                  style={{
                    ...styles.tag,
                    background: `${color}22`,
                    color,
                    borderColor: `${color}44`,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    cursor: isEditable ? 'pointer' : 'default',
                  }}
                >
                  {iconSrc && (
                    <img src={iconSrc} width={12} height={12} style={{ flexShrink: 0, display: 'block' }} />
                  )}
                  {CATEGORY_LABELS[cat] ?? cat}
                  {isEditable && <span style={{ opacity: 0.5, marginLeft: 2, display: 'flex', alignItems: 'center' }}><PencilIcon /></span>}
                </span>
              );
            })()
          ) : (feature.categories ?? []).map((cat) => {
            const color   = CATEGORY_COLORS[cat as Category] ?? '#9E9E9E';
            const rawSvg  = CATEGORY_SVGS[cat as Category];
            const iconSrc = rawSvg ? svgDataUri(colorSvg(rawSvg, color)) : null;
            const isEditable = feature.featureType === 'event' || feature.featureType === 'polity';
            return (
              <span
                key={cat}
                title={isEditable ? 'Click to reassign category' : undefined}
                onClick={isEditable ? () => setCategoryPickerOpen((v) => !v) : undefined}
                style={{
                  ...styles.tag,
                  background: `${color}22`,
                  color,
                  borderColor: `${color}44`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  cursor: isEditable ? 'pointer' : 'default',
                }}
              >
                {iconSrc && (
                  <img src={iconSrc} width={12} height={12} style={{ flexShrink: 0, display: 'block' }} />
                )}
                {CATEGORY_LABELS[cat as Category] ?? cat}
                {isEditable && <span style={{ opacity: 0.5, marginLeft: 2, display: 'flex', alignItems: 'center' }}><PencilIcon /></span>}
              </span>
            );
          })}
          {/* "+ Category" button for uncategorized events/polities */}
          {(feature.categories ?? []).length === 0 && (feature.featureType === 'event' || feature.featureType === 'polity') && (
            <button
              onClick={() => setCategoryPickerOpen((v) => !v)}
              style={{
                ...styles.tag,
                background: 'transparent',
                color: '#888',
                borderColor: '#555',
                borderStyle: 'dashed',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              + Category
            </button>
          )}
          {/* Category picker dropdown */}
          {categoryPickerOpen && (feature.featureType === 'event' || feature.featureType === 'polity') && (() => {
            const options = feature.featureType === 'polity' ? POLITY_CATEGORIES : EVENT_CATEGORIES;
            return (
              <div ref={categoryPickerRef} style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                zIndex: 100,
                background: '#1e1e1e',
                border: '1px solid #444',
                borderRadius: 6,
                padding: '4px 0',
                marginTop: 4,
                minWidth: 140,
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              }}>
                {options.map((opt) => {
                  const color = CATEGORY_COLORS[opt] ?? '#9E9E9E';
                  const isCurrent = (feature.categories ?? []).includes(opt);
                  return (
                    <button
                      key={opt}
                      disabled={categorySaving || isCurrent}
                      onClick={async () => {
                        if (isCurrent) return;
                        setCategorySaving(true);
                        try {
                          let updated: GeoJSON.Feature;
                          if (feature.featureType === 'polity') {
                            updated = await patchPolity(feature.id, { polity_type: opt });
                          } else {
                            updated = await patchFeature(feature.id, { categories: [opt] });
                          }
                          onFeatureUpdated(updated.properties as Partial<FeatureProperties>);
                          setCategoryPickerOpen(false);
                        } catch (e) {
                          console.error('Category save failed', e);
                        } finally {
                          setCategorySaving(false);
                        }
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        padding: '6px 12px',
                        background: isCurrent ? `${color}22` : 'transparent',
                        border: 'none',
                        color: isCurrent ? color : '#ccc',
                        fontSize: 12,
                        cursor: isCurrent ? 'default' : 'pointer',
                        textAlign: 'left',
                        opacity: categorySaving ? 0.5 : 1,
                      }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                      {CATEGORY_LABELS[opt] ?? opt}
                      {isCurrent && <span style={{ marginLeft: 'auto', fontSize: 10 }}>✓</span>}
                    </button>
                  );
                })}
                {/* Separator + None option */}
                <div style={{ borderTop: '1px solid #333', margin: '4px 0' }} />
                <button
                  disabled={categorySaving || (feature.categories ?? []).length === 0}
                  onClick={async () => {
                    setCategorySaving(true);
                    try {
                      let updated: GeoJSON.Feature;
                      if (feature.featureType === 'polity') {
                        updated = await patchPolity(feature.id, { polity_type: 'other' });
                      } else {
                        updated = await patchFeature(feature.id, { categories: [] });
                      }
                      onFeatureUpdated(updated.properties as Partial<FeatureProperties>);
                      setCategoryPickerOpen(false);
                    } catch (e) {
                      console.error('Category clear failed', e);
                    } finally {
                      setCategorySaving(false);
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '6px 12px',
                    background: 'transparent',
                    border: 'none',
                    color: '#666',
                    fontSize: 12,
                    cursor: (feature.categories ?? []).length === 0 ? 'default' : 'pointer',
                    textAlign: 'left',
                    opacity: categorySaving ? 0.5 : 1,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#444', flexShrink: 0 }} />
                  None
                  {(feature.categories ?? []).length === 0 && <span style={{ marginLeft: 'auto', fontSize: 10 }}>✓</span>}
                </button>
              </div>
            );
          })()}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button style={styles.iconBtn} onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {/* Image carousel */}
      {article && article.images.length > 0
        ? (
          <>
            {showImages && (
              <div style={{ position: 'relative', flexShrink: 0, background: '#000', cursor: 'pointer' }} onClick={() => setImageExpanded((v) => !v)}>
                <img
                  src={article.images[imageIndex]}
                  alt={`${feature.title} ${imageIndex + 1}`}
                  style={{
                    width: '100%',
                    height: imageExpanded ? 'auto' : 200,
                    maxHeight: imageExpanded ? '50vh' : 200,
                    objectFit: imageExpanded ? 'contain' : 'cover',
                    display: 'block',
                  }}
                />
                {article.images.length > 1 && (
                  <>
                    <button style={{ ...styles.imgArrow, left: 8 }} onClick={(e) => { e.stopPropagation(); setImageIndex((i) => (i - 1 + article.images.length) % article.images.length); }}>‹</button>
                    <button style={{ ...styles.imgArrow, right: 8 }} onClick={(e) => { e.stopPropagation(); setImageIndex((i) => (i + 1) % article.images.length); }}>›</button>
                    <div style={styles.imgCounter}>{imageIndex + 1} / {article.images.length}</div>
                  </>
                )}
              </div>
            )}
            <button onClick={() => setShowImages((v) => !v)} style={styles.imageToggle}>
              <span style={{ fontSize: 9, opacity: 0.4 }}>{showImages ? '▲' : '▼'}</span>
            </button>
          </>
        )
        : loading
          ? (
            // Match the loaded-state layout exactly so nothing below shifts
            // when the article resolves: same 200px image area + same toggle
            // row (rendered as a placeholder div for height parity).
            <>
              <div style={styles.imageLoader}>
                <div style={styles.spinner} />
              </div>
              <div style={styles.imageTogglePlaceholder} />
            </>
          )
          : null
      }

      {/* Title + date on same row */}
      <div style={styles.titleRow}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={styles.title}>{translatedContent?.title ?? feature.title}</h2>
          {translating && <span style={{ fontSize: 11, color: '#888', marginLeft: 4 }}>…</span>}
          {selectedLang !== 'en' && !translating && translatedContent === null && feature.wikidataQid && (
            <span style={{ fontSize: 11, color: '#aaa' }}>({LANG_CODE_TO_NAME[selectedLang] ?? selectedLang}: no translation)</span>
          )}
        </div>
        {dateStr && (
          <div style={styles.dateBlock}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={styles.dateMain}>{dateStr}</div>
              {(feature.featureType === 'event' || feature.featureType === 'polity') && (
                <button style={styles.pencilBtn} onClick={() => setEditField(f => f === 'date' ? null : 'date')} title="Correct this date on Wikipedia">
                  <PencilIcon />
                </button>
              )}
            </div>
            {feature.dateIsFuzzy && feature.dateRangeMin != null && feature.dateRangeMax != null && (
              <div style={styles.dateRange}>
                est. {displayYear(encodeDate(feature.dateRangeMin!))} – {displayYear(encodeDate(feature.dateRangeMax!))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Meta — location only */}
      {feature.locationName && feature.locationName !== feature.title && feature.locationName !== 'Unknown' && (() => {
        const locFeature = geojson?.features.find((f) => {
          const p = f.properties as FeatureProperties;
          // Prefer polity match by wikidata QID (most accurate for political entities)
          if (feature.locationWikidataQid && p.featureType === 'polity' && p.wikidataQid === feature.locationWikidataQid) return true;
          // Fall back to location by title
          return p.title === feature.locationName && (p.featureType === 'city' || p.featureType === 'region');
        });
        return (
          <div style={styles.meta}>
            {locFeature && onNavigateToFeature
              ? (
                <span
                  style={{ ...styles.metaLocation, color: '#3366cc', cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => onNavigateToFeature(locFeature.properties as FeatureProperties)}
                >
                  {feature.locationName}
                </span>
              )
              : <span style={styles.metaLocation}>{feature.locationName}</span>
            }
            {(feature.featureType === 'event' || feature.featureType === 'polity') && (
              <button style={{ ...styles.pencilBtn, marginLeft: 4 }} onClick={() => setEditField(f => f === 'location' ? null : 'location')} title="Correct this location on Wikipedia">
                <PencilIcon />
              </button>
            )}
          </div>
        );
      })()}

      {/* Location unknown — events only */}
      {feature.featureType === 'event' && (!feature.locationName || feature.locationName === 'Unknown') && (
        <div style={styles.meta}>
          <span style={{ ...styles.metaLocation, color: '#b0b0b0' }}>Location unknown</span>
          <button style={{ ...styles.pencilBtn, marginLeft: 4 }} onClick={() => setEditField(f => f === 'location' ? null : 'location')} title="Correct this location on Wikipedia">
            <PencilIcon />
          </button>
        </div>
      )}

      {/* Capital — polities only */}
      {isPolity && (() => {
        const capFeature = feature.capitalName ? geojson?.features.find((f) => {
          const p = f.properties as FeatureProperties;
          return feature.capitalWikidataQid
            ? p.wikidataQid === feature.capitalWikidataQid
            : p.title === feature.capitalName && (p.featureType === 'city' || p.featureType === 'region');
        }) : undefined;
        return (
          <>
            <div style={styles.meta}>
              <span style={{ ...styles.metaLocation, color: '#9a9a9a', fontSize: 12, marginRight: 4 }}>Capital:</span>
              {feature.capitalName
                ? capFeature && onNavigateToFeature
                  ? (
                    <span
                      style={{ ...styles.metaLocation, color: '#3366cc', cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() => onNavigateToFeature(capFeature.properties as FeatureProperties)}
                    >
                      {feature.capitalName}
                    </span>
                  )
                  : <span style={styles.metaLocation}>{feature.capitalName}</span>
                : <span style={{ ...styles.metaLocation, color: '#b0b0b0', fontStyle: 'italic' }}>unknown</span>
              }
              <button
                style={{ ...styles.pencilBtn, marginLeft: 4 }}
                onClick={() => {
                  setCapitalDraft({ name: feature.capitalName ?? '', lat: '', lng: '' });
                  setEditField(f => f === 'capital' ? null : 'capital');
                }}
                title="Correct this capital"
              >
                <PencilIcon />
              </button>
            </div>
            {editField === 'capital' && capitalDraft && (
              <div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  style={styles.editInput}
                  placeholder="Capital name"
                  value={capitalDraft.name}
                  onChange={e => setCapitalDraft(d => d && ({ ...d, name: e.target.value }))}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    style={{ ...styles.editInput, flex: 1 }}
                    placeholder="Latitude"
                    type="number"
                    step="any"
                    value={capitalDraft.lat}
                    onChange={e => setCapitalDraft(d => d && ({ ...d, lat: e.target.value }))}
                  />
                  <input
                    style={{ ...styles.editInput, flex: 1 }}
                    placeholder="Longitude"
                    type="number"
                    step="any"
                    value={capitalDraft.lng}
                    onChange={e => setCapitalDraft(d => d && ({ ...d, lng: e.target.value }))}
                  />
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    style={{ ...styles.saveBtn, opacity: capitalSaving ? 0.6 : 1 }}
                    disabled={capitalSaving || !capitalDraft.name.trim()}
                    onClick={async () => {
                      if (!capitalDraft.name.trim()) return;
                      setCapitalSaving(true);
                      const body: Record<string, unknown> = { capital_name: capitalDraft.name.trim(), capital_wikidata_qid: null };
                      const lat = parseFloat(capitalDraft.lat);
                      const lng = parseFloat(capitalDraft.lng);
                      if (!isNaN(lat) && !isNaN(lng)) { body.lat = lat; body.lng = lng; }
                      try {
                        const res = await fetch(`http://localhost:8000/api/polities/${feature.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(body),
                        });
                        if (res.ok) {
                          const updates: Partial<FeatureProperties> & { _coords?: [number, number] } = { capitalName: capitalDraft.name.trim(), capitalWikidataQid: null };
                          if (!isNaN(lat) && !isNaN(lng)) updates._coords = [lng, lat];
                          onFeatureUpdated(updates);
                          setEditField(null);
                          setCapitalDraft(null);
                        }
                      } finally {
                        setCapitalSaving(false);
                      }
                    }}
                  >
                    {capitalSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button style={styles.cancelBtn} onClick={() => { setEditField(null); setCapitalDraft(null); }}>Cancel</button>
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* Add to OHM — unmapped polities only */}
      {isPolity && !isOhmMapped && onAddToOhm && (
        <div style={{ padding: '4px 16px 8px' }}>
          <button
            onClick={async () => {
              // Search OHM first, log results
              const name = feature.title;
              console.log(`[OHM] Searching for "${name}"...`);
              const matches = await searchOhm(name);
              if (matches.length > 0) {
                console.log(`[OHM] Found ${matches.length} match(es):`, matches);
              } else {
                console.log(`[OHM] No matches found for "${name}"`);
              }
              onAddToOhm(feature);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'none',
              border: '1px solid #3366cc',
              borderRadius: 6,
              padding: '5px 12px',
              fontSize: 12,
              color: '#3366cc',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <span style={{ fontSize: 14 }}>+</span> Add to OHM
          </button>
        </div>
      )}

      {/* Inline correction form */}
      {editField && feature.wikipediaTitle && (
        <WikiEditForm
          feature={feature}
          field={editField}
          wikiAuth={wikiAuth}
          onAuth={onAuth}
          leadText={
            wikiAuth && (editField === 'date' || editField === 'location') && article?.leadHtml
              ? article.leadHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
              : undefined
          }
          onSuccess={(updates) => {
            onFeatureUpdated(updates);
            setEditField(null);
          }}
          onClose={() => setEditField(null)}
        />
      )}

      {/* Part of — hierarchy chips (events with P361 data only) */}
      {feature.featureType === 'event' && feature.partOfResolved && feature.partOfResolved.length > 0 && (() => {
        const resolved: { qid: string; title: string; slug: string }[] = Array.isArray(feature.partOfResolved)
          ? feature.partOfResolved
          : typeof feature.partOfResolved === 'string'
            ? (() => { try { return JSON.parse(feature.partOfResolved as unknown as string); } catch { return []; } })()
            : [];
        return (
          <div style={styles.partOfRow}>
            <span style={styles.partOfLabel}>Part of</span>
            <div style={styles.partOfChips}>
              {resolved.map(({ qid, title, slug }) => {
                const parentFeature = geojson?.features.find((f) => {
                  const p = f.properties as FeatureProperties;
                  return p.slug === slug || p.slug === qid || p.wikipediaTitle === slug;
                });
                return parentFeature && onNavigateToFeature ? (
                  <button
                    key={qid}
                    style={styles.partOfChip}
                    onClick={() => onNavigateToFeature(parentFeature.properties as FeatureProperties)}
                    title={`${title} — From Wikidata: part of (P361)`}
                  >
                    {title} →
                  </button>
                ) : (
                  <span
                    key={qid}
                    style={{ ...styles.partOfChip, cursor: 'default', opacity: 0.6 }}
                    title="From Wikidata: part of (P361)"
                  >
                    {title}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })()}

      <div style={styles.divider} />

      {/* Body — scrollable only when expanded */}
      <div ref={bodyRef} onClick={handleBodyClick} style={{
        ...styles.body,
        flex: (expanded || isMobile) ? 1 : undefined,
        overflowY: (expanded || isMobile) ? 'auto' : 'visible',
      }}>
        {!expanded ? (
          (() => {
            const summary = translatedContent?.summary || feature.wikipediaSummary || fetchedSummary;
            if (translatedContent && !translatedContent.hasArticle && !translatedContent.summary) {
              return <p style={{ ...styles.summary, color: '#aaa', fontStyle: 'italic' }}>No article in {LANG_CODE_TO_NAME[selectedLang] ?? selectedLang}</p>;
            }
            return <>
              {missingEnglishWiki && <MissingWikiNote qid={feature.wikidataQid!} onEdit={ohmEditHandler} />}
              <p style={styles.summary}>{summary}</p>
            </>;
          })()
        ) : loading ? (
          (() => {
            const summary = translatedContent?.summary || feature.wikipediaSummary || fetchedSummary;
            if (translatedContent && !translatedContent.hasArticle && !translatedContent.summary) {
              return <p style={{ ...styles.summary, color: '#aaa', fontStyle: 'italic' }}>No article in {LANG_CODE_TO_NAME[selectedLang] ?? selectedLang}</p>;
            }
            return <>
              {missingEnglishWiki && <MissingWikiNote qid={feature.wikidataQid!} onEdit={ohmEditHandler} />}
              <p style={styles.summary}>{summary}</p>
            </>;
          })()
        ) : article ? (
          <>
            {/* Lead section */}
            <div
              className="wiki-content"
              style={styles.leadContent}
              dangerouslySetInnerHTML={{ __html: article.leadHtml }}
            />

            {/* Sections accordion — skip pure reference/footnote sections */}
            {article.sections.filter((s) => !/^(references?|notes?|footnotes?|citations?|bibliography|further reading|external links?|see also)$/i.test(s.title)).map((section) => {
              const isOpen = openSections.has(section.index);
              const html = sectionHtml.get(section.index);
              const isLoadingSection = loadingSections.has(section.index);
              return (
                <div key={section.index} data-section={section.index} style={styles.sectionWrap}>
                  <button
                    style={{
                      ...styles.sectionHeader,
                      paddingLeft: 16 + Math.max(0, section.level - 1) * 12,
                    }}
                    onClick={() => toggleSection(section)}
                  >
                    <span style={{
                      ...styles.sectionTitle,
                      fontWeight: section.level === 1 ? 700 : 500,
                      fontSize: section.level === 1 ? 13 : 12,
                    }}>
                      {section.title}
                    </span>
                    <span style={styles.chevron}>{isOpen ? '▲' : '▼'}</span>
                  </button>
                  {isOpen && (
                    isLoadingSection || !html ? (
                      <p style={{ ...styles.loadingText, padding: '6px 16px 12px' }}>Loading…</p>
                    ) : (
                      <div
                        className="wiki-content"
                        style={styles.sectionBody}
                        dangerouslySetInnerHTML={{ __html: html }}
                      />
                    )
                  )}
                </div>
              );
            })}
          </>
        ) : (
          (() => {
            const summary = translatedContent?.summary || feature.wikipediaSummary || fetchedSummary;
            if (!summary && !missingEnglishWiki) return null;
            return <>
              {missingEnglishWiki && <MissingWikiNote qid={feature.wikidataQid!} onEdit={ohmEditHandler} />}
              {summary && <p style={styles.summary}>{summary}</p>}
            </>;
          })()
        )}
      </div>

      {/* Stories featuring this event */}
      {feature.featureType === 'event' && onStartStory && (() => {
        const matchingStories = storyIndex.filter((s) => s.anchor_qid === feature.wikidataQid);
        if (matchingStories.length === 0) return null;
        return (
          <div style={styles.storiesSection}>
            <div style={styles.storiesSectionLabel}>Stories featuring this event</div>
            {matchingStories.map((entry) => (
              <div key={entry.slug} style={styles.storyCard}>
                <div style={styles.storyCardMeta}>
                  <span style={styles.storyCardTitle}>{entry.title}</span>
                  <span style={styles.storyCardBadge}>{entry.detail_level.replace('_', ' ')}</span>
                </div>
                {entry.description && (
                  <p style={styles.storyCardDesc}>{entry.description}</p>
                )}
                <div style={styles.storyCardFooter}>
                  <span style={styles.storyCardBeats}>{entry.beat_count} beats</span>
                  <button style={styles.storyStartBtn} onClick={() => onStartStory(entry.slug)}>
                    Start →
                  </button>
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Footer */}
      <div style={{ ...styles.footer, borderTop: expanded ? '1px solid rgba(0,0,0,0.07)' : 'none' }}>
        {!expanded ? (
          <>
            {feature.wikipediaUrl && (
              <button style={styles.readBtn} onClick={() => setExpanded(true)}>
                Read article ↓
              </button>
            )}
            {feature.wikipediaUrl && (
              <a href={feature.wikipediaUrl} target="_blank" rel="noopener noreferrer" style={styles.extBtn} title="Open in Wikipedia">
                ↗
              </a>
            )}
            {onHideFeature && (feature.featureType === 'polity' || feature.featureType === 'event') && (
              <button
                onClick={() => onHideFeature(feature.id, feature.featureType as 'polity' | 'event')}
                title="Hide from map — this entry won't appear on the map. You can unhide it in the Data Viewer."
                style={styles.extBtn as React.CSSProperties}
              >
                Hide
              </button>
            )}
            {stack.total > 1 && <StackDots stack={stack} />}
          </>
        ) : (
          <>
            {feature.wikipediaUrl && (
              <a href={feature.wikipediaUrl} target="_blank" rel="noopener noreferrer" style={styles.wikiBtn}>
                Open in Wikipedia ↗
              </a>
            )}
            {onHideFeature && (feature.featureType === 'polity' || feature.featureType === 'event') && (
              <button
                onClick={() => onHideFeature(feature.id, feature.featureType as 'polity' | 'event')}
                title="Hide from map — this entry won't appear on the map. You can unhide it in the Data Viewer."
                style={styles.extBtn as React.CSSProperties}
              >
                Hide
              </button>
            )}
            {stack.total > 1 && <StackDots stack={stack} />}
          </>
        )}
      </div>
    </div>
  );
}

function StackDots({ stack }: { stack: StackInfo }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
      {Array.from({ length: stack.total }, (_, i) => (
        <div
          key={i}
          style={{
            height: 6,
            borderRadius: 3,
            transition: 'all 0.2s ease',
            background: i === stack.index ? '#202122' : 'rgba(0,0,0,0.2)',
            width: i === stack.index ? 16 : 6,
          }}
        />
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'fixed',
    top: 114,
    right: 0,
    width: 360,
    maxWidth: '100vw',
    background: '#ffffff',
    borderRadius: '12px 0 0 12px',
    border: '1px solid rgba(0,0,0,0.1)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
    zIndex: 90,
    color: '#202122',
    display: 'flex',
    flexDirection: 'column',
    animation: 'slideInRight 0.2s ease',
  },
  accent: {
    height: 3,
    flexShrink: 0,
    borderRadius: '12px 12px 0 0',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 14px 10px',
    gap: 8,
    flexShrink: 0,
  },
  headerLeft: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
    minWidth: 0,
  },
  iconBtn: {
    background: 'rgba(0,0,0,0.05)',
    border: '1px solid rgba(0,0,0,0.1)',
    borderRadius: 6,
    color: '#54595d',
    fontSize: 12,
    width: 26,
    height: 26,
    cursor: 'pointer',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'inherit',
  },
  tag: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 4,
    border: '1px solid',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    whiteSpace: 'nowrap' as const,
  },
  imgArrow: {
    position: 'absolute' as const,
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'rgba(0,0,0,0.55)',
    border: 'none',
    color: '#fff',
    fontSize: 22,
    width: 30,
    height: 30,
    borderRadius: '50%',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'inherit',
    lineHeight: 1,
  },
  imgCounter: {
    position: 'absolute' as const,
    bottom: 6,
    right: 8,
    background: 'rgba(0,0,0,0.5)',
    color: '#fff',
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 7px',
    borderRadius: 10,
  },
  imageToggle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    padding: '4px 0',
    background: 'none',
    border: 'none',
    borderBottom: '1px solid rgba(0,0,0,0.07)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  imageLoader: {
    width: '100%',
    // Match the loaded image height (`height: 200` on the <img>) exactly so the
    // body content doesn't shift up when the article resolves.
    height: 200,
    flexShrink: 0,
    background: 'rgba(0,0,0,0.04)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Empty stand-in for the image-toggle button row in the loading state.
  // Same dimensions and border as styles.imageToggle so swapping in the real
  // button at article-resolve time doesn't change the layout height.
  imageTogglePlaceholder: {
    width: '100%',
    // height = padding (4px top + 4px bottom) + font-size (9px) ≈ 17px; round
    // up to 17 to match the rendered <button>.
    height: 17,
    borderBottom: '1px solid rgba(0,0,0,0.07)',
    flexShrink: 0,
  },
  spinner: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    border: '3px solid rgba(0,0,0,0.1)',
    borderTopColor: '#3366cc',
    animation: 'spin 0.8s linear infinite',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '10px 16px 8px',
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: 700,
    lineHeight: 1.35,
    color: '#202122',
    letterSpacing: '-0.01em',
    minWidth: 0,
  },
  dateBlock: {
    flexShrink: 0,
    textAlign: 'right' as const,
    paddingTop: 2,
  },
  dateMain: {
    fontSize: 12,
    fontWeight: 600,
    color: '#54595d',
    whiteSpace: 'nowrap' as const,
    letterSpacing: '0.01em',
  },
  dateRange: {
    fontSize: 11,
    color: '#9a9a9a',
    whiteSpace: 'nowrap' as const,
    marginTop: 2,
  },
  meta: {
    padding: '0 16px 8px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
  },
  metaLocation: { fontSize: 13, color: '#54595d' },
  pencilBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#b0b0b0',
    padding: '2px 3px',
    borderRadius: 4,
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    lineHeight: 1,
  },
  partOfRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '0 16px 12px',
    flexShrink: 0,
  },
  partOfLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#9a9a9a',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    whiteSpace: 'nowrap' as const,
    paddingTop: 3,
  },
  partOfChips: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 4,
  },
  partOfChip: {
    fontSize: 11,
    fontWeight: 500,
    color: '#3366cc',
    background: 'rgba(51,102,204,0.08)',
    border: '1px solid rgba(51,102,204,0.2)',
    borderRadius: 4,
    padding: '2px 8px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap' as const,
    maxWidth: 200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  editInput: {
    fontSize: 12,
    padding: '5px 8px',
    borderRadius: 5,
    border: '1px solid rgba(0,0,0,0.18)',
    fontFamily: 'inherit',
    background: '#fafafa',
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  saveBtn: {
    fontSize: 12,
    fontWeight: 600,
    color: '#fff',
    background: '#3366cc',
    border: 'none',
    borderRadius: 5,
    padding: '5px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  cancelBtn: {
    fontSize: 12,
    color: '#54595d',
    background: 'rgba(0,0,0,0.05)',
    border: '1px solid rgba(0,0,0,0.1)',
    borderRadius: 5,
    padding: '5px 10px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  divider: {
    height: 1,
    background: 'rgba(0,0,0,0.07)',
    flexShrink: 0,
  },
  body: {
    minHeight: 0,
  },
  summary: {
    fontSize: 13.5,
    lineHeight: 1.65,
    color: '#54595d',
    padding: '14px 16px',
  },
  loadingText: {
    fontSize: 13,
    color: '#9a9a9a',
    padding: '14px 16px',
  },
  leadContent: {
    padding: '14px 16px 4px',
  },
  sectionWrap: {
    borderTop: '1px solid rgba(0,0,0,0.06)',
  },
  sectionHeader: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 16,
    paddingTop: 10,
    paddingBottom: 10,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left' as const,
    gap: 8,
  },
  sectionTitle: {
    color: '#202122',
    flex: 1,
    minWidth: 0,
  },
  chevron: {
    fontSize: 8,
    color: '#9a9a9a',
    flexShrink: 0,
  },
  sectionBody: {
    padding: '0 16px 14px',
  },
  storiesSection: {
    borderTop: '1px solid rgba(0,0,0,0.07)',
    padding: '12px 16px',
    flexShrink: 0,
  },
  storiesSectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.07em',
    color: '#72777d',
    marginBottom: 8,
  },
  storyCard: {
    background: '#f0f4ff',
    borderRadius: 8,
    padding: '10px 12px',
    marginBottom: 6,
    border: '1px solid rgba(26,35,126,0.12)',
  },
  storyCardMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  storyCardTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: '#202122',
    flex: 1,
  },
  storyCardBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: '#1a237e',
    background: 'rgba(26,35,126,0.1)',
    borderRadius: 4,
    padding: '2px 6px',
    textTransform: 'capitalize' as const,
    flexShrink: 0,
  },
  storyCardDesc: {
    fontSize: 12,
    color: '#555',
    margin: '0 0 8px',
    lineHeight: 1.4,
  },
  storyCardFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  storyCardBeats: {
    fontSize: 11,
    color: '#72777d',
  },
  storyStartBtn: {
    background: '#1a237e',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    padding: '5px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    flexShrink: 0,
  },
  readBtn: {
    fontSize: 12,
    fontWeight: 600,
    color: '#ffffff',
    background: '#3366cc',
    border: 'none',
    borderRadius: 6,
    padding: '6px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    letterSpacing: '0.01em',
    whiteSpace: 'nowrap' as const,
  },
  extBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 28,
    height: 28,
    padding: '0 8px',
    background: 'rgba(0,0,0,0.04)',
    border: '1px solid rgba(0,0,0,0.1)',
    borderRadius: 6,
    fontSize: 12,
    fontFamily: 'inherit',
    color: '#54595d',
    textDecoration: 'none',
    flexShrink: 0,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  wikiBtn: {
    fontSize: 12,
    fontWeight: 600,
    color: '#ffffff',
    background: '#3366cc',
    border: 'none',
    borderRadius: 6,
    padding: '6px 12px',
    textDecoration: 'none',
    letterSpacing: '0.01em',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap' as const,
  },
};
