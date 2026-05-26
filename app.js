/**
 * app.js — Galaxy Morphology Classifier
 * ─────────────────────────────────────────────────────────────────
 * All application logic. No external libraries; runs entirely in
 * the browser. The only network calls made are to three trusted
 * astronomy APIs (NASA Image Library, NED, hips2fits) to fetch
 * imagery and catalog data. All pixel analysis runs locally.
 *
 * Table of contents:
 *   §1   Security utilities
 *   §2   Constants & configuration
 *   §3   Application state
 *   §4   Modal management
 *   §5   Tab switching
 *   §6   Console log helpers
 *   §7   Status message helpers
 *   §8   NASA Image Library API
 *   §9   NED (NASA/IPAC Extragalactic Database) lookup
 *  §10   hips2fits multi-wavelength sky cutouts
 *  §11   File upload handling
 *  §12   Image loading → raw pixel data
 *  §13   Pixel analysis — image processing primitives
 *  §14   Pixel analysis — photometric / morphometric metrics
 *  §15   Pixel analysis — classification decision tree
 *  §16   Canvas rendering helpers (visualisation strip)
 *  §17   Main pixel analysis pipeline runner
 *  §18   Results renderer
 *  §19   Reset / utility
 */


/* ═══════════════════════════════════════════════════════════
   §1  SECURITY UTILITIES
   ─────────────────────────────────────────────────────────
   All data received from external APIs (NASA titles, NED names,
   survey labels, error messages) MUST pass through esc() before
   being inserted via innerHTML. This prevents XSS if an API
   response is ever compromised or returns unexpected characters.

   Structural DOM content (e.g. card titles, measurement keys)
   uses textContent instead of innerHTML and does not need esc().
═══════════════════════════════════════════════════════════ */

/**
 * HTML-escape a string so it is safe to inject into innerHTML.
 * Escapes the five characters that have special meaning in HTML:
 *   & → &amp;   < → &lt;   > → &gt;   " → &quot;   ' → &#39;
 *
 * @param  {*}      s  - Any value; coerced to string.
 * @returns {string}   - HTML-safe string.
 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}


/* ═══════════════════════════════════════════════════════════
   §2  CONSTANTS & CONFIGURATION
═══════════════════════════════════════════════════════════ */

/** Maximum allowed upload size in bytes (10 MB). */
const MAX_FILE = 10 * 1024 * 1024;

/**
 * MIME types accepted in the file upload path.
 * The <input accept="…"> attribute is a UI hint only — we enforce
 * this in JS as well because accept can be bypassed.
 */
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * URL prefixes considered trusted for remote image loading.
 * Any URL that does not start with one of these is rejected before
 * being passed to the canvas pixel reader (§12).
 *
 * NASA image CDN:      images-assets.nasa.gov
 * CDS primary mirror:  alasky.cds.unistra.fr
 * CDS backup mirror:   alaskybis.cds.unistra.fr
 *
 * Note: SIMBAD (simbad.cds.unistra.fr) is used for catalog lookups only
 * (JSON, no pixel data) and does not need to be in this image allowlist.
 */
const TRUSTED_DOMAINS = [
  'https://images-assets.nasa.gov/',
  'https://alasky.cds.unistra.fr/',
  'https://alaskybis.cds.unistra.fr/',
];

/**
 * hips2fits sky surveys fetched for the NED name-lookup tab.
 * Each entry uses a CDS HiPS identifier.
 *
 * DSS2   — Digitized Sky Survey 2, all-sky visible-light plates
 * SDSS9  — Sloan Digital Sky Survey, deep optical
 * PanSTARRS — Pan-STARRS DR1, optical/NIR
 * 2MASS  — Near-infrared (J/H/K); traces old stellar mass
 * GALEX  — Ultraviolet; traces recent star formation
 */
const HIPS_SURVEYS = [
  { id: 'CDS/P/DSS2/color',                     label: 'DSS2 (optical)'    },
  { id: 'CDS/P/SDSS9/color',                    label: 'SDSS (deep)'       },
  { id: 'CDS/P/PanSTARRS/DR1/color-i-r-g',     label: 'Pan-STARRS'        },
  { id: 'CDS/P/2MASS/color',                    label: '2MASS (NIR)'       },
  { id: 'CDS/P/GALEXGR6/AIS/color',             label: 'GALEX (UV)'        },
];

/**
 * Ordered list of Hubble types used to render the chip strip.
 * Covers ellipticals (E), lenticulars (S0), normal spirals (S),
 * barred spirals (SB), and irregulars (Irr).
 */
const HUBBLE_SEQ = [
  'E0','E3','E6','S0','Sa','Sab','Sb','Sbc','Sc','Sd','Sdm',
  'SBa','SBb','SBbc','SBc','SBcd','SBd','SBm','Irr'
];


/* ═══════════════════════════════════════════════════════════
   §3  APPLICATION STATE
   Single mutable object that holds all runtime state.
   Updated in place by the various handler functions.
═══════════════════════════════════════════════════════════ */
const state = {
  /** Currently active input tab: 'search' | 'name' | 'upload' */
  tab: 'search',

  /** NASA Image Library pagination */
  nasaPage:  1,
  nasaTotal: 0,
  nasaQuery: '',

  /** URL of the image currently shown in the preview pane */
  selectedUrl:   null,
  /** Human-readable label for the selected image (filename or NASA title) */
  selectedTitle: null,

  /**
   * Raw pixel data from the selected image.
   * Populated by loadImageData() after the image is drawn to a hidden canvas.
   * null if pixel access was blocked by CORS.
   */
  imgData: null,
  imgW:    0,   // pixel width of the loaded image
  imgH:    0,   // pixel height

  /**
   * Base64-encoded JPEG of the image (for potential future use).
   * Produced as a side-effect of loadImageData().
   */
  selectedBase64: null,
  selectedMime:   'image/jpeg',

  /**
   * Data returned by NED after a successful name lookup.
   * { name, ra, dec, z, type }
   * null if not applicable (NASA search or upload tabs).
   */
  nedData: null,

  /**
   * Full result object from the last pixel analysis run.
   * { hubble, simplified, confidence, notes, metrics }
   * null if analysis hasn't been run yet.
   */
  pixelResult: null,
};


/* ═══════════════════════════════════════════════════════════
   §4  MODAL MANAGEMENT
   Opens/closes the Security modal overlay.
   Also handles backdrop-click and Escape-key dismissal.
═══════════════════════════════════════════════════════════ */

/**
 * Show the modal with the given id (e.g. 'security').
 * Locks body scroll to prevent background scrolling while modal is open.
 * @param {string} id
 */
function openModal(id) {
  document.getElementById('modal-' + id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

/**
 * Hide the modal with the given id and restore body scroll.
 * @param {string} id
 */
function closeModal(id) {
  document.getElementById('modal-' + id).classList.add('hidden');
  document.body.style.overflow = '';
}

/**
 * Scroll to a methodology section and update the active nav link.
 * Called by onclick attributes on .meth-nav-link elements.
 * Uses the .meth-body scroll container rather than the page scroll,
 * since the modal content area scrolls independently.
 *
 * @param {string} sectionId - The id of the target <section> element.
 */
function methScroll(sectionId) {
  const target    = document.getElementById(sectionId);
  const container = document.getElementById('meth-scroll-body');
  if (!target || !container) return;

  // Scroll the content pane so the section is at the top
  container.scrollTo({ top: target.offsetTop - 8, behavior: 'smooth' });

  // Update active nav link highlight
  document.querySelectorAll('.meth-nav-link').forEach(el => {
    el.classList.toggle('active', el.getAttribute('onclick')?.includes(sectionId));
  });
}

// Close any open modal when user clicks the dark overlay backdrop
document.querySelectorAll('.modal-overlay').forEach(el => {
  el.addEventListener('click', e => {
    if (e.target === el) closeModal(el.id.replace('modal-', ''));
  });
});

// Close any open modal when user presses Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(el => {
      el.classList.add('hidden');
      document.body.style.overflow = '';
    });
  }
});


/* ═══════════════════════════════════════════════════════════
   §5  TAB SWITCHING
   Shows one input tab panel and hides the others.
═══════════════════════════════════════════════════════════ */

/**
 * Activate the given tab and deactivate the rest.
 * Adds/removes the 'hidden' class on tab panels and
 * the 'active' class on tab buttons.
 * @param {string} t - 'search' | 'name' | 'upload'
 */
function switchTab(t) {
  state.tab = t;
  ['search', 'upload'].forEach(id => {
    document.getElementById('tab-' + id).classList.toggle('hidden', id !== t);
  });
  document.querySelectorAll('.tab').forEach((el, i) => {
    el.classList.toggle('active', ['search', 'upload'][i] === t);
  });
}


/* ═══════════════════════════════════════════════════════════
   §6  CONSOLE LOG HELPERS
   Appends styled log lines to the analysis console panel.
   Each line has: [elapsed_time]  TYPE_TAG  message
═══════════════════════════════════════════════════════════ */

/** Timestamp (ms) when the current analysis run started. */
let consoleStart = 0;

/**
 * Cached reference to the console output element.
 * Populated lazily on first use so it is safe even if the script runs before
 * the DOM is fully parsed (though in practice the module-level event listeners
 * below already depend on DOM readiness).
 */
let _consoleEl = null;

/**
 * Append a line to the analysis console.
 *
 * Supported types and their colour coding:
 *   'step' (blue)   — pipeline stage announcements
 *   'data' (teal)   — intermediate measurement values
 *   'ok'   (green)  — success confirmations
 *   'warn' (yellow) — non-fatal warnings
 *   'err'  (red)    — errors
 *   'info' (purple) — general info / separators
 *
 * @param {string} msg  - Message HTML (may contain trusted inline spans).
 * @param {string} type - Log type key (see above).
 */
function clog(msg, type = 'info') {
  if (!_consoleEl) _consoleEl = document.getElementById('console-out');
  const el = _consoleEl;
  if (!el) return;

  // Elapsed time since analysis started
  const elapsed = ((Date.now() - consoleStart) / 1000).toFixed(3);

  const tagLabels = { step: 'STEP', data: 'DATA', ok: 'OK', warn: 'WARN', err: 'ERR', info: 'INFO' };
  const tag = tagLabels[type] || 'INFO';

  const line = document.createElement('div');
  line.className = 'log-line';
  // Note: msg is always a string we construct internally, never raw API data.
  // External strings passed as msg are run through esc() at the call site.
  // elapsed is always a numeric string from toFixed(3); type/tag are hardcoded
  // literals — none can contain HTML special characters, so esc() is omitted.
  line.innerHTML =
    `<span class="log-ts">[${esc(elapsed)}s]</span>` +
    `<span class="log-tag tag-${type}">${tag}</span>` +
    `<span class="log-msg msg-${type}">${msg}</span>`;

  el.appendChild(line);
  el.scrollTop = el.scrollHeight; // auto-scroll to the newest line
}

/** Clear all log lines and reset the elapsed-time counter. */
function clearConsole() {
  if (!_consoleEl) _consoleEl = document.getElementById('console-out');
  if (_consoleEl) _consoleEl.innerHTML = '';
  consoleStart = Date.now();
}

/**
 * Convenience wrapper for logging a labelled numeric metric.
 * Renders as: "label: value unit" with the value in amber.
 * @param {string} label
 * @param {string|number} value
 * @param {string} [unit='']
 */
function clogMetric(label, value, unit = '') {
  clog(
    `<span class="msg-dim">${esc(label)}:</span> ` +
    `<span class="msg-metric">${esc(String(value))}` +
    (unit ? `<span class="msg-dim"> ${esc(unit)}</span>` : '') +
    `</span>`,
    'data'
  );
}


/* ═══════════════════════════════════════════════════════════
   §7  STATUS MESSAGE HELPERS
   Controls the small feedback areas beneath search fields
   and the analyze button. Each area has its own id.
═══════════════════════════════════════════════════════════ */

/**
 * Show a status message in the element with the given id.
 * @param {string}  id    - Element id (e.g. 'nasa-status').
 * @param {string}  msg   - Message HTML (trusted string we construct).
 * @param {boolean} isErr - If true, applies the .err (red) style.
 */
function showStatus(id, msg, isErr) {
  const el = document.getElementById(id);
  el.innerHTML  = msg;
  el.className  = 'status' + (isErr ? ' err' : '');
  el.style.display = 'block';
}

/**
 * Hide the status message area with the given id.
 * @param {string} id
 */
function hideStatus(id) {
  document.getElementById(id).style.display = 'none';
}

/**
 * Show a CORS-error helper in the #analyze-status area with a single
 * action button. Two-phase attempt:
 *
 *   Phase 1 — Re-fetch as blob → synthetic File → handleFile()
 *     Tries fetch() one more time. If the request succeeds (CORS headers
 *     present on retry, or the previous failure was transient), the blob
 *     is wrapped in a File object and fed directly into handleFile(),
 *     which processes it exactly like a manual upload with no user steps.
 *
 *   Phase 2 — Trigger browser download → auto-switch to Upload tab
 *     If fetch() is still blocked (no CORS headers), we create a hidden
 *     <a download> link and click it programmatically. The browser saves
 *     the file (it can download images even without CORS — CORS only blocks
 *     JavaScript from reading the bytes). We then switch to the Upload tab
 *     so the user only needs to drag the downloaded file to the drop zone.
 *
 * @param {string} imgUrl - The blocked remote image URL (from TRUSTED_DOMAINS).
 */
function showCorsHelper(imgUrl) {
  const el = document.getElementById('analyze-status');
  el.className     = 'status err';
  el.style.display = 'block';
  el.innerHTML     = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'cors-helper';

  const msg = document.createElement('span');
  msg.className   = 'cors-helper-msg';
  msg.textContent = "⚠ NASA's CDN blocked direct pixel access for this image.";
  wrapper.appendChild(msg);

  const btn = document.createElement('button');
  btn.id        = 'cors-fetch-btn';
  btn.className = 'cors-fetch-btn';
  btn.textContent = '⬇ Load image for analysis';
  btn.addEventListener('click', () => fetchAndLoadImage(imgUrl));
  wrapper.appendChild(btn);

  el.appendChild(wrapper);
}

/**
 * Attempt to load a CORS-blocked image for pixel analysis.
 * Called automatically by selectNasaImage() as the default procedure.
 *
 * @param {string} imgUrl - Remote image URL (validated against TRUSTED_DOMAINS).
 * @param {string} [title] - Optional label for the image.
 */
async function fetchAndLoadImage(imgUrl, title) {
  try {
    // Phase 1: fetch() → blob → synthetic File → handleFile()
    // Using mode:'cors' with credentials:'omit'. If the CDN has added or
    // temporarily allows CORS, this will succeed and we get the raw bytes.
    const res = await fetch(imgUrl, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();

    // Derive a sane filename from the URL
    const filename = title
      ? String(title).slice(0, 80).replace(/[^a-zA-Z0-9 _\-]/g, '_') + '.jpg'
      : decodeURIComponent(
          imgUrl.split('/').pop().split('?')[0] || 'galaxy.jpg'
        ).slice(0, 120);

    // Wrap the blob as a File — handleFile() validates MIME and size then
    // calls setSelectedImage(), which will be able to read pixels from a
    // local blob with no CORS restrictions at all.
    const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });

    hideStatus('analyze-status');
    handleFile(file);      // processes exactly like a manual upload

  } catch (_) {
    // Phase 2: fetch() still blocked — open the image URL in a new tab.
    // We do NOT use <a download> on cross-origin URLs because browsers ignore
    // the download attribute for cross-origin resources (security policy) and
    // navigate the current page instead. Opening a new tab is always safe.
    window.open(imgUrl, '_blank', 'noopener,noreferrer');

    // Switch to upload tab and show a clear next-step message
    switchTab('upload');
    const el = document.getElementById('analyze-status');
    el.className     = 'status';
    el.style.display = 'block';
    el.innerHTML     = '';
    const m = document.createElement('span');
    m.className   = 'cors-helper-msg';
    m.textContent = '⬇ Image opened in a new tab — save it, then drag it onto the drop zone above, or click the zone to browse.';
    el.appendChild(m);
  }
}


/* ═══════════════════════════════════════════════════════════
   §8  NASA IMAGE LIBRARY API
   ─────────────────────────────────────────────────────────
   Endpoint: https://images-api.nasa.gov/search
   No API key required. Returns Collection+JSON.
   Results are rendered as clickable image cards.
═══════════════════════════════════════════════════════════ */

/**
 * Search the NASA Image Library and render result cards.
 * Called by the Search button and Enter key in the search input.
 * @param {number} [page=1] - Page number (20 results per page).
 */
async function nasaSearch(page) {
  const q = document.getElementById('nasa-q').value.trim().slice(0, 200);
  if (!q) return;

  state.nasaQuery = q;
  state.nasaPage  = page || 1;

  const btn = document.getElementById('nasa-btn');
  btn.disabled = true;
  showStatus('nasa-status', '<span class="spinner"></span>Searching NASA image library…');
  document.getElementById('nasa-grid').innerHTML = '';
  document.getElementById('nasa-pager').classList.add('hidden');

  try {
    const url = `https://images-api.nasa.gov/search` +
      `?q=${encodeURIComponent(q)}&media_type=image` +
      `&page=${state.nasaPage}&page_size=20`;

    const res  = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data  = await res.json();
    const items = data.collection?.items || [];
    state.nasaTotal = data.collection?.metadata?.total_hits || 0;

    hideStatus('nasa-status');

    if (!items.length) {
      showStatus('nasa-status', 'No images found.');
      btn.disabled = false;
      return;
    }

    // Build and inject image cards using DOM methods (not innerHTML)
    // to prevent XSS from untrusted API titles.
    const grid = document.getElementById('nasa-grid');
    items.forEach(item => {
      const info  = item.data?.[0] || {};
      const thumb = item.links?.find(l => l.rel === 'preview')?.href || '';
      const title  = String(info.title || 'Untitled').slice(0, 80);
      const nasaId = String(info.nasa_id || '');
      const year   = String(info.date_created || '').slice(0, 4);
      const center = String(info.center || '').slice(0, 20);

      const div  = document.createElement('div');  div.className = 'img-card';
      const img  = document.createElement('img');  img.alt = title; img.loading = 'lazy';
      img.onerror = () => { img.style.opacity = '.2'; };

      // Only load images from the trusted NASA CDN
      if (thumb.startsWith('https://images-assets.nasa.gov/')) img.src = thumb;

      // "Open Image in New Tab" button — the ONLY interactive element on the card.
      // Handled synchronously so browsers permit the popup.
      // The card div itself has no click handler — images never navigate the current page.
      const newTabBtn = document.createElement('button');
      newTabBtn.className = 'img-card-newtab';
      newTabBtn.setAttribute('type', 'button');
      newTabBtn.setAttribute('aria-label', 'Open image in new tab: ' + title);
      newTabBtn.textContent = '↗ Open Image in New Tab';
      newTabBtn.addEventListener('click', e => {
        e.stopPropagation();
        window.open(thumb, '_blank', 'noopener,noreferrer');
      });

      // Use textContent for all user-visible text to avoid innerHTML injection
      const idiv = document.createElement('div'); idiv.className = 'img-card-info';
      const t    = document.createElement('div'); t.className = 'img-card-title'; t.textContent = title;
      const s    = document.createElement('div'); s.className = 'img-card-sub';   s.textContent = (year ? year + ' · ' : '') + center;

      idiv.appendChild(t); idiv.appendChild(s);
      div.appendChild(img); div.appendChild(newTabBtn); div.appendChild(idiv);
      // No card-level click handler — the tooltip button is the sole action.
      grid.appendChild(div);
    });

    // Show pagination controls when there are more than 20 results
    const pager = document.getElementById('nasa-pager');
    if (state.nasaTotal > 20) {
      pager.classList.remove('hidden');
      document.getElementById('nasa-pager-info').textContent =
        `Page ${state.nasaPage} · ${state.nasaTotal.toLocaleString()} results`;
      document.getElementById('nasa-prev').disabled = state.nasaPage <= 1;
      document.getElementById('nasa-next').disabled = state.nasaPage * 20 >= state.nasaTotal;
    }

  } catch (e) {
    showStatus('nasa-status', '⚠ Search failed. Check your connection.', true);
    console.error(e);
  }

  btn.disabled = false;
}

/** Move to the adjacent page in NASA search results. */
function nasaPage(dir) {
  nasaSearch(state.nasaPage + dir);
}

/**
 * Resolve the best available image URL for a NASA asset.
 * Prefers ~large or ~medium variants from the /asset manifest;
 * falls back to the first non-JSON item, then the thumbnail.
 *
 * @param {string} thumbUrl - Thumbnail URL (fallback).
 * @param {string} nasaId   - NASA asset ID.
 * @returns {Promise<string>} Resolved image URL.
 */
async function resolveNasaUrl(thumbUrl, nasaId) {
  let imgUrl = thumbUrl;
  try {
    if (nasaId && /^[a-zA-Z0-9_\-]+$/.test(nasaId)) {
      const r = await fetch(`https://images-api.nasa.gov/asset/${encodeURIComponent(nasaId)}`);
      if (r.ok) {
        const d   = await r.json();
        const its = d.collection?.items || [];
        const lrg = its.find(i =>
          typeof i.href === 'string' &&
          i.href.startsWith('https://images-assets.nasa.gov/') &&
          (i.href.includes('~large') || i.href.includes('~medium'))
        );
        if (lrg) {
          imgUrl = lrg.href;
        } else {
          const f = its.find(i =>
            typeof i.href === 'string' &&
            i.href.startsWith('https://images-assets.nasa.gov/') &&
            !i.href.endsWith('.json') &&
            !i.href.endsWith('.vtt')
          );
          if (f) imgUrl = f.href;
        }
      }
    }
  } catch (_) { /* non-fatal — thumbnail is a fine fallback */ }
  return imgUrl;
}

/**
 * Handle clicking a NASA result card.
 * Resolves the best image URL then starts the fetch/analysis pipeline.
 * Does NOT open a new tab — that is handled by the per-card hover button.
 *
 * @param {HTMLElement} el       - The card element (for selection highlight).
 * @param {string}      thumbUrl - Thumbnail URL as fallback.
 * @param {string}      title
 * @param {string}      nasaId
 */
async function selectNasaImage(el, thumbUrl, title, nasaId) {
  document.querySelectorAll('.img-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');

  const imgUrl = await resolveNasaUrl(thumbUrl, nasaId);

  // Show preview immediately
  document.getElementById('main-preview').src = imgUrl;
  document.getElementById('preview-label').textContent =
    String(title || 'TARGET').slice(0, 50).toUpperCase();
  document.getElementById('analyze-section').classList.remove('hidden');
  document.getElementById('results-section').classList.add('hidden');
  document.getElementById('analysis-panel').classList.add('hidden');
  hideStatus('analyze-status');
  showStatus('analyze-status', '<span class="spinner"></span>Downloading image for analysis…');
  document.getElementById('analyze-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  await fetchAndLoadImage(imgUrl, title);
}


/* ═══════════════════════════════════════════════════════════
   §9  NED (NASA/IPAC EXTRAGALACTIC DATABASE) LOOKUP
   ─────────────────────────────────────────────────────────
   Endpoint: https://ned.ipac.caltech.edu/srs/ObjectLookup
   No API key required. Returns JSON.
   ResultCode 3 = found; other codes = error conditions.
═══════════════════════════════════════════════════════════ */

/**
 * Look up a galaxy name, display its catalog data, then trigger
 * hips2fits cutout loading if coordinates are available.
 *
 * Strategy:
 *   1. Try NED ObjectLookup (primary — richest data).
 *   2. If NED fails with a network/CORS error ("Failed to fetch"),
 *      silently fall back to SIMBAD TAP, which has reliable CORS headers.
 *   3. If both fail, show a clear error.
 *
 * Called by the Lookup button and Enter key in the name input.
 */
async function nameLookup() {
  const q = document.getElementById('ned-q').value.trim().slice(0, 120);
  if (!q) return;

  const btn = document.getElementById('ned-btn');
  btn.disabled = true;
  showStatus('ned-status', '<span class="spinner"></span>Querying NED…');
  document.getElementById('ned-result').classList.add('hidden');
  state.nedData = null;

  // ── Attempt 1: NED ObjectLookup ──────────────────────────────────────────
  let nedSuccess = false;
  try {
    const r = await fetch(
      `https://ned.ipac.caltech.edu/srs/ObjectLookup?name=${encodeURIComponent(q)}`,
      { mode: 'cors', credentials: 'omit' }
    );
    if (!r.ok) throw new Error('NED HTTP ' + r.status);
    const j = await r.json();

    // NED result codes: 0=uninterpretable, 1=ambiguous, 2=not found, 3=success
    if (j.ResultCode === 3) {
      const pref = j.Preferred;
      const name = String(pref.Name  || q).slice(0, 100);
      const ra   = typeof pref.Position?.RA    === 'number' ? pref.Position.RA    : null;
      const dec  = typeof pref.Position?.Dec   === 'number' ? pref.Position.Dec   : null;
      const z    = typeof pref.Redshift?.Value === 'number' ? pref.Redshift.Value : null;
      const type = String(pref.ObjType?.Value  || '').slice(0, 20);

      state.nedData = { name, ra, dec, z, type, source: 'NED' };
      renderCatalogCard(name, ra, dec, z, type, 'NED');

      if (ra != null && dec != null) await loadHipsCutouts(name, ra, dec);
      hideStatus('ned-status');
      nedSuccess = true;

    } else if (j.ResultCode === 1) {
      // Ambiguous — this is a definitive API answer, don't fall back to SIMBAD
      throw new Error('Ambiguous name — try being more specific (e.g. "NGC 1300" instead of "NGC 13").');
    } else if (j.ResultCode === 2) {
      // Explicitly not found in NED — fall through to SIMBAD silently
    } else {
      throw new Error('NED returned code ' + j.ResultCode);
    }

  } catch (e) {
    // If it was a deliberate user-facing error (ambiguous, parse fail), re-throw
    if (e.message.startsWith('Ambiguous') || e.message.startsWith('NED returned')) {
      showStatus('ned-status', '⚠ ' + esc(e.message.slice(0, 120)), true);
      btn.disabled = false;
      return;
    }
    // Otherwise (network/CORS failure, or not-found) fall through to SIMBAD
  }

  if (nedSuccess) { btn.disabled = false; return; }

  // ── Attempt 2: SIMBAD TAP fallback ───────────────────────────────────────
  // SIMBAD (Centre de Données astronomiques de Strasbourg) has reliable CORS
  // headers and covers all objects in NED's catalog and more.
  showStatus('ned-status', '<span class="spinner"></span>NED unavailable — trying SIMBAD…');
  try {
    // Escape single quotes in the name to prevent ADQL injection
    const safeName = q.replace(/'/g, "''");
    const adql = `SELECT ra, dec, otype_txt FROM basic JOIN ident ON basic.oid = ident.oidref WHERE id = '${safeName}'`;
    const url  = `https://simbad.cds.unistra.fr/simbad/sim-tap/sync` +
                 `?REQUEST=doQuery&LANG=ADQL&FORMAT=json&QUERY=${encodeURIComponent(adql)}`;

    const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!r.ok) throw new Error('SIMBAD HTTP ' + r.status);
    const j = await r.json();

    if (!j.data || j.data.length === 0) {
      throw new Error(`"${q}" not found in NED or SIMBAD. Check the spelling — try catalog names like "NGC 1300" or "M 51".`);
    }

    const [ra, dec, otype] = j.data[0];
    const name = q; // SIMBAD doesn't return a canonical name in this query; use as entered
    const type = String(otype || 'G').slice(0, 20);

    state.nedData = { name, ra, dec, z: null, type, source: 'SIMBAD' };
    renderCatalogCard(name, ra, dec, null, type, 'SIMBAD');

    if (ra != null && dec != null) await loadHipsCutouts(name, ra, dec);
    hideStatus('ned-status');

  } catch (e) {
    const msg = e.message.length < 160 ? e.message : 'Lookup failed. Check name and try again.';
    showStatus('ned-status', '⚠ ' + esc(msg), true);
  }

  btn.disabled = false;
}

/**
 * Populate the NED/SIMBAD catalog card with resolved object data.
 * Extracted from nameLookup() so both code paths share one renderer.
 *
 * @param {string}      name   - Object name.
 * @param {number|null} ra     - Right ascension (decimal degrees).
 * @param {number|null} dec    - Declination (decimal degrees).
 * @param {number|null} z      - Redshift (null if unavailable from SIMBAD).
 * @param {string}      type   - Object type code.
 * @param {string}      source - 'NED' or 'SIMBAD' (shown as a badge).
 */
function renderCatalogCard(name, ra, dec, z, type, source) {
  // Source badge — lets the user know which catalog answered
  const sourceLabel = source === 'SIMBAD' ? 'SIMBAD (NED unavailable)' : 'NED';
  document.getElementById('ned-name').textContent = name;

  // Small source indicator appended after the name
  const existing = document.getElementById('ned-source-badge');
  if (existing) existing.remove();
  const badge = document.createElement('span');
  badge.id          = 'ned-source-badge';
  badge.textContent = sourceLabel;
  badge.style.cssText = 'font-size:9px;color:var(--text3);letter-spacing:.08em;margin-left:8px;';
  document.getElementById('ned-name').appendChild(badge);

  const grid = document.getElementById('ned-fields');
  grid.innerHTML = '';
  [
    ['RA (J2000)',  ra  != null ? ra.toFixed(6)  + '°' : '—'],
    ['Dec (J2000)', dec != null ? dec.toFixed(6) + '°' : '—'],
    ['Redshift z',  z   != null ? z.toFixed(5)         : '—'],
    ['Type',        type || '—'],
  ].forEach(([l, v]) => {
    const it = document.createElement('div');
    const lb = document.createElement('div'); lb.className = 'ned-lbl'; lb.textContent = l;
    const vl = document.createElement('div'); vl.className = 'ned-val'; vl.textContent = v;
    it.appendChild(lb); it.appendChild(vl);
    grid.appendChild(it);
  });

  document.getElementById('ned-result').classList.remove('hidden');
}


/* ═══════════════════════════════════════════════════════════
   §10  HIPS2FITS MULTI-WAVELENGTH SKY CUTOUTS
   ─────────────────────────────────────────────────────────
   Endpoint: https://alasky.cds.unistra.fr/hips-image-services/hips2fits/cutout
   No API key required. Returns JPEG directly (no JSON step).
   Five surveys are requested: DSS2, SDSS, Pan-STARRS, 2MASS, GALEX.
═══════════════════════════════════════════════════════════ */

/**
 * Fetch five sky cutouts at the given coordinates and render them
 * as clickable image cards below the NED data card.
 *
 * @param {string} name - Galaxy name (for card labels).
 * @param {number} ra   - Right ascension in decimal degrees.
 * @param {number} dec  - Declination in decimal degrees.
 */
async function loadHipsCutouts(name, ra, dec) {
  showStatus('hips-status', '<span class="spinner"></span>Fetching multi-wavelength sky cutouts…');

  const grid = document.getElementById('hips-previews');
  grid.innerHTML = '';

  HIPS_SURVEYS.forEach(sv => {
    // Build the hips2fits URL:
    //   hips       — survey identifier
    //   ra, dec    — target coordinates
    //   fov        — field of view in degrees (0.18° ≈ 11 arcmin, good for nearby galaxies)
    //   width/height — output image size in pixels
    //   projection — TAN (gnomonic), standard for small-field astronomy
    //   format     — jpg for browser display
    //   stretch    — asinh to reveal low-surface-brightness features
    const url =
      'https://alasky.cds.unistra.fr/hips-image-services/hips2fits/cutout' +
      `?hips=${encodeURIComponent(sv.id)}` +
      `&ra=${ra}&dec=${dec}` +
      `&fov=0.18&width=300&height=300&projection=TAN&format=jpg&stretch=asinh`;

    const div = document.createElement('div'); div.className = 'img-card'; div.style.opacity = '.5';

    const img = document.createElement('img');
    img.alt         = sv.label;
    img.crossOrigin = 'anonymous'; // needed for later canvas pixel access
    img.src         = url;
    img.onload  = () => { div.style.opacity = '1'; };
    img.onerror = () => { div.style.opacity = '.3'; }; // dim card if survey unavailable at this position

    const idiv = document.createElement('div'); idiv.className = 'img-card-info';
    const t    = document.createElement('div'); t.className = 'img-card-title'; t.textContent = name;
    const s    = document.createElement('div'); s.className = 'img-card-sub';   s.textContent = sv.label;

    idiv.appendChild(t); idiv.appendChild(s);
    div.appendChild(img); div.appendChild(idiv);

    div.addEventListener('click', () => {
      document.querySelectorAll('#hips-previews .img-card').forEach(c => c.classList.remove('selected'));
      div.classList.add('selected');
      setSelectedImage(url, name + ' — ' + sv.label);
    });

    grid.appendChild(div);
  });

  showStatus('hips-status', '5 wavelength bands loaded — click one to analyze ↓');
}


/* ═══════════════════════════════════════════════════════════
   §11  FILE UPLOAD HANDLING
   Drag-and-drop and click-to-browse for the Upload tab.
   Validates MIME type and file size before reading pixel data.
═══════════════════════════════════════════════════════════ */

const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

// Drag-and-drop visual feedback
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('dragging'));

// Handle actual drop
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

// Handle file-picker selection
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

/**
 * Validate and read an uploaded File object.
 * Security checks:
 *   1. MIME type must be in ALLOWED_TYPES (not just the input accept attribute)
 *   2. File size must be ≤ MAX_FILE (10 MB) to avoid OOM in large canvases
 *
 * @param {File} file
 */
function handleFile(file) {
  if (!ALLOWED_TYPES.includes(file.type)) {
    alert('Unsupported file type. Please upload a JPEG, PNG, WEBP, or GIF.');
    return;
  }
  if (file.size > MAX_FILE) {
    alert(`File too large (${(file.size / 1048576).toFixed(1)} MB). Maximum is 10 MB.`);
    return;
  }

  state.selectedMime = file.type;

  const reader = new FileReader();
  reader.onload = ev => {
    // readAsDataURL produces a data: URI — no domain validation needed for local files
    const dataUrl = ev.target.result;
    setSelectedImage(dataUrl, file.name, /* isDataUrl */ true);
  };
  reader.readAsDataURL(file);
}


/* ═══════════════════════════════════════════════════════════
   §12  IMAGE LOADING → RAW PIXEL DATA
   Takes a URL or data URI, draws it onto a hidden canvas,
   and extracts the raw ImageData for the pixel analysis engine.
═══════════════════════════════════════════════════════════ */

/**
 * Set the selected image: show preview, validate URL, extract pixels.
 * This is the central funnel — all three input methods end up here.
 *
 * @param {string}  url       - Image URL or data: URI.
 * @param {string}  title     - Human-readable label for the preview tag.
 * @param {boolean} isDataUrl - true for uploaded files (skip domain check).
 */
async function setSelectedImage(url, title, isDataUrl = false) {
  state.selectedUrl   = url;
  state.selectedTitle = title;
  state.imgData       = null;
  state.selectedBase64 = null;

  // Security: reject remote URLs from untrusted domains
  if (!isDataUrl && !TRUSTED_DOMAINS.some(d => url.startsWith(d))) {
    console.warn('Untrusted image URL blocked:', url);
    return;
  }

  // Update the preview pane
  document.getElementById('main-preview').src = url;
  document.getElementById('preview-label').textContent =
    String(title || 'TARGET').slice(0, 50).toUpperCase();

  // Show the preview / analyze section, reset downstream UI
  document.getElementById('analyze-section').classList.remove('hidden');
  document.getElementById('results-section').classList.add('hidden');
  document.getElementById('analysis-panel').classList.add('hidden');
  hideStatus('analyze-status');

  try {
    // Attempt to read raw pixel data into state.imgData
    const { imgData, b64, w, h } = await loadImageData(url, isDataUrl);
    state.imgData        = imgData;
    state.imgW           = w;
    state.imgH           = h;
    state.selectedBase64 = b64;
    state.selectedMime   = 'image/jpeg';

    // Pixel data is ready — automatically kick off analysis
    runPixelAnalysis();

  } catch (e) {
    // All pixel-read attempts failed (CORS / network).
    // The image is still visible in the preview (the <img> element loads fine),
    // but getImageData() is blocked. Show a helper message.
    showCorsHelper(url);
  }

  document.getElementById('analyze-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Draw an image onto an off-screen canvas and extract its pixel data.
 * Returns a promise resolving to { imgData, b64, w, h }.
 *
 * Three-attempt strategy for remote URLs:
 *
 *   Attempt 1 — fetch() → Blob → blob: URL → canvas
 *     fetch() retrieves the raw bytes. We create a blob: URL from the response
 *     which the browser treats as same-origin, so canvas.getImageData() is never
 *     tainted even if the server has no CORS headers. This is the primary path
 *     for NASA images because images-assets.nasa.gov does not consistently send
 *     Access-Control-Allow-Origin headers on all image variants.
 *
 *   Attempt 2 — img with crossOrigin="anonymous" → canvas
 *     Falls back here only if fetch() itself fails (network error, strict
 *     server-side fetch blocking, etc.). Works when the CDN does send CORS headers.
 *
 *   Attempt 3 — throws, caller shows download UI
 *     If both attempts fail the promise rejects and setSelectedImage() renders
 *     a "Save & Re-upload" helper so the user can download the file and drag it
 *     to the Upload tab, bypassing all remote-image restrictions entirely.
 *
 * @param {string}  url       - Image URL or data: URI.
 * @param {boolean} isDataUrl - If true, skips both remote attempts.
 * @returns {Promise<{imgData: ImageData, b64: string, w: number, h: number}>}
 */
async function loadImageData(url, isDataUrl) {
  // ── Data URL / local file: draw directly, never tainted ──────────────────
  if (isDataUrl) {
    return loadFromSrc(url, false);
  }

  // ── Attempt 1: fetch → blob: URL ─────────────────────────────────────────
  // A blob: URL is same-origin so getImageData() is always allowed.
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob    = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    try {
      return await loadFromSrc(blobUrl, false);
    } finally {
      URL.revokeObjectURL(blobUrl); // free memory whether we succeed or not
    }
  } catch (_) {
    // fetch() failed (no CORS headers, network error, etc.) — try img fallback
  }

  // ── Attempt 2: img element with crossOrigin="anonymous" ──────────────────
  // Works when the server sends Access-Control-Allow-Origin.
  return loadFromSrc(url, true /* add crossOrigin="anonymous" */);
}

/**
 * Internal helper: draw a URL or blob: URL into an off-screen canvas
 * and return the pixel data. Rejects if the canvas is tainted.
 *
 * @param {string}  src            - Image src (URL, blob: URL, or data: URI).
 * @param {boolean} setCrossOrigin - Whether to set crossOrigin="anonymous".
 * @returns {Promise<{imgData, b64, w, h}>}
 */
function loadFromSrc(src, setCrossOrigin) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (setCrossOrigin) img.crossOrigin = 'anonymous';

    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;

      const cv  = document.createElement('canvas');
      cv.width  = w;
      cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);

      try {
        const imgData = ctx.getImageData(0, 0, w, h); // throws if canvas is tainted
        const b64     = cv.toDataURL('image/jpeg', 0.92).split(',')[1];
        resolve({ imgData, b64, w, h });
      } catch (e) {
        reject(e);
      }
    };

    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}


/* ═══════════════════════════════════════════════════════════
   §13  PIXEL ANALYSIS — IMAGE PROCESSING PRIMITIVES
   Low-level functions that operate on raw pixel buffers.
   Each takes/returns Float32Array or Float64Array for speed.
═══════════════════════════════════════════════════════════ */

/**
 * Yield control back to the browser event loop.
 * Called between heavy computation steps so the canvas and console
 * can repaint before the next step starts. This makes the analysis
 * feel live rather than hanging until completion.
 * @returns {Promise<void>}
 */
const yld = () => new Promise(r => setTimeout(r, 0));

/**
 * Convert an RGBA ImageData to a Float32 luminance (grayscale) array.
 * Uses the Rec.709 HDTV luminance coefficients:
 *   Y = 0.2126 R + 0.7152 G + 0.0722 B
 * This is perceptually accurate (green contributes ~72% of perceived brightness).
 *
 * @param   {ImageData}   imgData  - Raw ImageData from canvas.getImageData().
 * @returns {Float32Array}         - Grayscale values in range [0, 255], length w×h.
 */
function toGray(imgData) {
  const d = imgData.data;
  const n = imgData.width * imgData.height;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    g[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  }
  return g;
}

/**
 * Compute the brightness-weighted centroid (photometric center of mass).
 * Equivalent to the first moment of the luminosity distribution.
 *
 * NOTE: When a full second-moment fit is also needed, use secondMoments()
 * directly — it returns the centroid as part of its single-pass computation,
 * making a separate centroid() call redundant.
 *
 * @param   {Float32Array} g   - Grayscale pixel buffer.
 * @param   {number}       w   - Image width in pixels.
 * @param   {number}       h   - Image height in pixels.
 * @returns {{ x: number, y: number }}  - Centroid coordinates in pixel space.
 */
function centroid(g, w, h) {
  let sx = 0, sy = 0, sw = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = g[y * w + x];
      sx += x * v;
      sy += y * v;
      sw += v;
    }
  }
  return { x: sx / sw, y: sy / sw };
}

/**
 * Fit an ellipse to the galaxy by computing image second moments.
 * The second moment tensor (covariance matrix of pixel positions weighted
 * by brightness) has eigenvalues proportional to the squared semi-axes
 * of the best-fit ellipse.
 *
 * Also computes the brightness-weighted centroid in the same pass,
 * so a separate centroid() call is unnecessary when both are needed.
 *
 * Returns:
 *   cx    — centroid x (same as centroid().x)
 *   cy    — centroid y (same as centroid().y)
 *   axisA — semi-major axis length in pixels
 *   cx    — centroid x
 *   cy    — centroid y
 *   axisA — semi-major axis length in pixels
 *   axisB — semi-minor axis length in pixels
 *   ba    — axis ratio b/a (0 = line, 1 = circle)
 *   pa    — position angle in degrees (0–180, CCW from vertical)
 *   eps   — ellipticity = 1 − b/a
 *
 * @param {Float32Array} g                   - Grayscale pixel buffer.
 * @param {number}       w                   - Width.
 * @param {number}       h                   - Height.
 * @returns {{ cx, cy, axisA, axisB, ba, pa, eps }}
 */
function secondMoments(g, w, h) {
  // Pass 1 of 1: compute first moments (centroid) and second moments together.
  // First we need the centroid to centre the second-moment sums, but we cannot
  // compute centred second moments in a single literal pass without knowing cx/cy
  // first. The standard approach is two logical passes over the same buffer:
  //   sub-pass A: accumulate weighted sums for cx, cy (first moments)
  //   sub-pass B: accumulate centred second moments using the cx, cy from A
  // Both sub-passes are tight inner loops; no extra memory allocation is needed.

  // Sub-pass A — first moments (centroid)
  let sx = 0, sy = 0, sw = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = g[y * w + x];
      sx += x * v; sy += y * v; sw += v;
    }
  }
  if (sw === 0) return { cx: w / 2, cy: h / 2, axisA: 0, axisB: 0, ba: 1, pa: 0, eps: 0 };
  const cx = sx / sw;
  const cy = sy / sw;

  // Sub-pass B — centred second moments
  let Mxx = 0, Myy = 0, Mxy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v  = g[y * w + x];
      const dx = x - cx, dy = y - cy;
      Mxx += dx * dx * v;
      Myy += dy * dy * v;
      Mxy += dx * dy * v;
    }
  }
  Mxx /= sw; Myy /= sw; Mxy /= sw;

  // Eigenvalues of the 2×2 moment matrix via the quadratic formula:
  //   λ = (tr ± √(tr²/4 − det)) / 2
  const tr   = Mxx + Myy;
  const det  = Mxx * Myy - Mxy * Mxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const e1   = tr / 2 + disc; // larger eigenvalue → semi-major axis²
  const e2   = tr / 2 - disc; // smaller eigenvalue → semi-minor axis²

  const axisA = Math.sqrt(Math.max(0, e1));
  const axisB = Math.sqrt(Math.max(0, e2));
  const ba    = axisA > 0 ? Math.min(1, axisB / axisA) : 1;

  // PA from the eigenvector of the larger eigenvalue
  const pa    = Math.atan2(2 * Mxy, Mxx - Myy) / 2 * (180 / Math.PI);
  const paDeg = ((pa % 180) + 180) % 180; // normalise to [0°, 180°)

  return { cx, cy, axisA, axisB, ba, pa: paDeg, eps: 1 - ba };
}

/**
 * Compute the radial brightness profile by averaging pixel luminance
 * inside concentric annular rings centred on (cx, cy).
 *
 * Optimisation: dy² is hoisted outside the inner x-loop, saving one
 * multiply per pixel. The sqrt is still needed for bin assignment since
 * bin = floor(r/step) requires knowing r — a lookup table would be faster
 * for very large images but adds significant complexity.
 *
 * @param {Float32Array} g    - Grayscale pixel buffer.
 * @param {number}       w, h - Image dimensions.
 * @param {number}       cx   - Centroid x.
 * @param {number}       cy   - Centroid y.
 * @param {number}       bins - Number of annular bins.
 * @returns {{ profile: Float64Array, radii: number[], maxR: number, step: number }}
 */
function radialProfile(g, w, h, cx, cy, bins) {
  // Maximum usable radius: largest circle that fits inside the image
  const maxR   = Math.min(cx, w - cx, cy, h - cy);
  const step   = maxR / bins;
  const invStep = 1 / step; // precompute reciprocal to replace division with multiply

  const sums   = new Float64Array(bins);
  const counts = new Uint32Array(bins);

  for (let y = 0; y < h; y++) {
    const dy   = y - cy;
    const dySq = dy * dy; // hoisted — saves one multiply per pixel in the x loop
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const r  = Math.sqrt(dx * dx + dySq);
      const b  = Math.min(bins - 1, Math.floor(r * invStep));
      sums[b]   += g[y * w + x];
      counts[b] += 1;
    }
  }

  const profile = new Float64Array(bins);
  for (let i = 0; i < bins; i++) {
    profile[i] = counts[i] > 0 ? sums[i] / counts[i] : 0;
  }

  // Mid-point radii for each bin (for plotting and Sérsic fitting)
  const radii = Array.from({ length: bins }, (_, i) => (i + 0.5) * step);

  return { profile, radii, maxR, step };
}

/**
 * Separable box blur using a sliding-window sum accumulator — O(W×H).
 *
 * The naïve approach visits 2r+1 neighbours per pixel per axis pass, giving
 * O(W×H×r). The sliding-window technique instead maintains a running sum:
 *   sum += g[leading_edge] − g[trailing_edge]
 * so each pixel costs exactly two additions regardless of r.
 *
 * Boundary pixels use a smaller effective kernel that stays within the image
 * (clamped/valid-border semantics) — the same semantic as the old code.
 *
 * Not a true Gaussian but a good approximation at low kernel radii.
 *
 * @param {Float32Array} g    - Input grayscale buffer.
 * @param {number}       w, h - Image dimensions.
 * @param {number}       r    - Half-width of the box kernel in pixels.
 * @returns {Float32Array}    - Blurred output buffer.
 */
function boxBlur(g, w, h, r) {
  const temp = new Float32Array(w * h);
  const out  = new Float32Array(w * h);

  // ── Horizontal pass (rows) ─────────────────────────────────────────────────
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    let cnt = 0;
    // Initialise the window covering x = [0, r]
    for (let x = 0; x <= Math.min(r, w - 1); x++) { sum += g[row + x]; cnt++; }
    for (let x = 0; x < w; x++) {
      temp[row + x] = sum / cnt;
      // Slide: add incoming right edge (if within bounds)
      const xIn = x + r + 1;
      if (xIn < w) { sum += g[row + xIn]; cnt++; }
      // Remove outgoing left edge (if within bounds)
      const xOut = x - r;
      if (xOut >= 0) { sum -= g[row + xOut]; cnt--; }
    }
  }

  // ── Vertical pass (columns) over horizontal-pass result ───────────────────
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let cnt = 0;
    // Initialise the window covering y = [0, r]
    for (let y = 0; y <= Math.min(r, h - 1); y++) { sum += temp[y * w + x]; cnt++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / cnt;
      const yIn = y + r + 1;
      if (yIn < h) { sum += temp[yIn * w + x]; cnt++; }
      const yOut = y - r;
      if (yOut >= 0) { sum -= temp[yOut * w + x]; cnt--; }
    }
  }

  return out;
}

/**
 * Sobel edge detection.
 * Applies the 3×3 Sobel operator to compute gradient magnitude at each pixel.
 * The kernel is:
 *   Gx = [-1,0,+1; -2,0,+2; -1,0,+1]
 *   Gy = [+1,+2,+1;  0,0,0; -1,-2,-1]
 *   |G| = sqrt(Gx² + Gy²)
 *
 * @param {Float32Array} g    - Input grayscale buffer.
 * @param {number}       w, h - Image dimensions.
 * @returns {Float32Array}    - Edge magnitude buffer (same shape as input).
 */
function sobelEdges(g, w, h) {
  const e = new Float32Array(w * h);
  // Skip the 1-pixel border to avoid out-of-bounds reads
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -g[(y-1)*w+(x-1)] + g[(y-1)*w+(x+1)]
        -2*g[y*w+(x-1)]   + 2*g[y*w+(x+1)]
        -g[(y+1)*w+(x-1)] + g[(y+1)*w+(x+1)];
      const gy =
         g[(y-1)*w+(x-1)] + 2*g[(y-1)*w+x] + g[(y-1)*w+(x+1)]
        -g[(y+1)*w+(x-1)] - 2*g[(y+1)*w+x] - g[(y+1)*w+(x+1)];
      e[y*w+x] = Math.sqrt(gx*gx + gy*gy);
    }
  }
  return e;
}


/* ═══════════════════════════════════════════════════════════
   §14  PIXEL ANALYSIS — PHOTOMETRIC / MORPHOMETRIC METRICS
   Higher-level metrics derived from the primitives above.
   These are the CAS (Concentration–Asymmetry–Clumpiness) indices
   plus Sérsic profile fitting, bar detection, and spiral indicator.
═══════════════════════════════════════════════════════════ */

/**
 * Fit a Sérsic surface brightness profile to the radial profile.
 *
 * The Sérsic law: I(r) = I_e · exp(−b_n · [(r/r_e)^(1/n) − 1])
 * Taking the log: ln I = const − b_n · (r/r_e)^(1/n)
 *
 * For each candidate Sérsic index n, we linearize by setting
 * x = (r/r_e)^(1/n) and fitting ln I = a + b·x by least squares.
 * The best-fit n is the one that maximises R².
 *
 * Physical interpretation:
 *   n ≈ 0.5  — Gaussian (unusual; might be a nucleus)
 *   n ≈ 1.0  — Exponential disk (pure late-type spirals)
 *   n ≈ 2–3  — Intermediate (bulge + disk)
 *   n ≈ 4.0  — de Vaucouleurs law (ellipticals)
 *   n > 4    — Super-de-Vaucouleurs (cD galaxies)
 *
 * @param {Float64Array} profile    - Mean brightness per annular bin.
 * @param {number[]}     radii      - Bin mid-point radii in pixels.
 * @param {number}       totalFlux  - Pre-computed sum of profile (avoids duplicate sum with concentration()).
 * @returns {{ n: number, re: number, r2: number }}
 *   n  — best-fit Sérsic index
 *   re — half-light radius in pixels
 *   r2 — R² goodness-of-fit for the chosen n
 */
function sersicFit(profile, radii, totalFlux) {
  const N = profile.length;

  // Find the half-light radius: first bin where cumulative flux ≥ 50% of total
  let cum = 0, reIdx = 0;
  for (let i = 0; i < N; i++) {
    cum += profile[i];
    if (cum >= totalFlux * 0.5) { reIdx = i; break; }
  }
  const re = radii[reIdx] || 1;

  const nCandidates = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 6.0];
  // Pre-allocate reusable buffers — avoids 16 array allocations (2 per candidate)
  const xs = new Float64Array(N);
  const ys = new Float64Array(N);
  let bestN = 1, bestR2 = -Infinity;

  for (const nc of nCandidates) {
    let n2 = 0;
    for (let i = 1; i < N; i++) {
      if (profile[i] > 0.5 && radii[i] > 0) {
        xs[n2] = Math.pow(radii[i] / re, 1 / nc);
        ys[n2] = Math.log(profile[i]);
        n2++;
      }
    }
    if (n2 < 4) continue;

    // Ordinary least-squares slope and intercept
    let sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (let i = 0; i < n2; i++) { sx += xs[i]; sy += ys[i]; sxy += xs[i]*ys[i]; sx2 += xs[i]*xs[i]; }
    const slope = (n2*sxy - sx*sy) / (n2*sx2 - sx*sx);
    const inter = (sy - slope*sx) / n2;

    // R² coefficient of determination
    const ymean = sy / n2;
    let ssTot = 0, ssRes = 0;
    for (let i = 0; i < n2; i++) {
      const yhat = inter + slope * xs[i];
      ssTot += (ys[i] - ymean) ** 2;
      ssRes += (ys[i] - yhat)  ** 2;
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    if (r2 > bestR2) { bestR2 = r2; bestN = nc; }
  }

  return { n: bestN, re, r2: bestR2 };
}

/**
 * Compute the CAS concentration index C.
 * C = 5 · log₁₀(r₈₀ / r₂₀)
 * where r₂₀ and r₈₀ enclose 20% and 80% of the total cumulative flux.
 *
 * Typical ranges:
 *   C > 4.5 — very concentrated (giant ellipticals)
 *   C 3.5–4.5 — high (normal ellipticals, Sa spirals)
 *   C 2.5–3.5 — moderate (Sb–Sc spirals)
 *   C < 2.5 — low (late spirals, irregulars)
 *
 * @param {Float64Array} profile
 * @param {number[]}     radii
 * @param {number}       [preTotal] - Pre-computed profile sum (optional; avoids duplicate sum).
 * @returns {{ C: number, r20: number, r80: number }}
 */
function concentration(profile, radii, preTotal) {
  let total = preTotal !== undefined ? preTotal : 0;
  if (preTotal === undefined) for (const v of profile) total += v;

  let cum = 0;
  let r20 = radii[0], r80 = radii[radii.length - 1];
  let found20 = false, found80 = false;

  for (let i = 0; i < profile.length; i++) {
    cum += profile[i];
    const frac = cum / total;
    if (!found20 && frac >= 0.2) { r20 = radii[i]; found20 = true; }
    if (!found80 && frac >= 0.8) { r80 = radii[i]; found80 = true; break; }
  }

  const C = r20 > 0 ? 5 * Math.log10(r80 / r20) : 0;
  return { C: Math.max(0, C), r20, r80 };
}

/**
 * Compute the CAS asymmetry index A.
 * A = Σ|I(x,y) − I₁₈₀(x,y)| / (2 · Σ|I(x,y)|)
 * where I₁₈₀ is the image rotated 180° about the centroid.
 *
 * A = 0 → perfectly symmetric (ideal elliptical)
 * A > 0.35 → highly asymmetric (irregular / merger)
 *
 * @param {Float32Array} g      - Grayscale buffer.
 * @param {number}       w, h   - Image dimensions.
 * @param {number}       cx, cy - Centroid.
 * @returns {number} A ∈ [0, 1]
 */
function asymmetry(g, w, h, cx, cy) {
  const cxi = Math.round(cx), cyi = Math.round(cy);
  let sd = 0, so = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v  = g[y * w + x];
      // Mirror position: reflect (x,y) through the centroid
      const mx = 2 * cxi - x;
      const my = 2 * cyi - y;
      const mv = (mx >= 0 && mx < w && my >= 0 && my < h) ? g[my * w + mx] : 0;
      sd += Math.abs(v - mv);
      so += Math.abs(v);
    }
  }

  return so > 0 ? sd / (2 * so) : 0;
}

/**
 * Compute the CAS clumpiness index S.
 * S = Σ_galaxy max(I − I_smooth, 0) / Σ_galaxy I
 * where I_smooth is a box-blurred version of the image.
 * Only pixels within 3·rₑ of the centroid are included (galaxy region).
 *
 * S ≈ 0   — smooth (ellipticals, S0s)
 * S > 0.2 — clumpy (active star-forming regions in late spirals)
 *
 * @param {Float32Array} g       - Original grayscale buffer.
 * @param {Float32Array} blurred - Box-blurred version of g.
 * @param {number}       cx, cy  - Centroid.
 * @param {number}       re      - Half-light radius (defines galaxy region).
 * @param {number}       w       - Image width in pixels.
 * @param {number}       h       - Image height in pixels.
 * @returns {number} S ≥ 0
 */
function clumpiness(g, blurred, cx, cy, re, w, h) {
  let sr = 0, so = 0;
  const re2  = re * re;
  const cxi  = Math.round(cx), cyi = Math.round(cy);
  const r3sq = re2 * 9; // (3·rₑ)² — skip pixels beyond this

  for (let y = 0; y < h; y++) {
    const dy = y - cyi;
    const dySq = dy * dy;
    if (dySq > r3sq) continue; // skip entire row early
    for (let x = 0; x < w; x++) {
      const dx = x - cxi;
      const d2 = dx * dx + dySq;
      if (d2 > r3sq) continue; // skip pixels beyond 3·rₑ

      const i   = y * w + x;
      const res = g[i] - blurred[i];
      if (res > 0) sr += res; // only positive residuals count as clumps
      so += g[i];
    }
  }

  return so > 0 ? sr / so : 0;
}

/**
 * Detect a bar structure by comparing the second moments of the
 * inner region (r < 0.4·rₑ) with the outer disk (0.4·rₑ < r < 1.5·rₑ).
 *
 * A bar causes the inner region to be much more elongated than the outer
 * disk, with the elongation axis aligned to within ~30° between the two.
 *
 * Uses squared-distance comparisons to avoid one Math.sqrt() call per pixel.
 *
 * Returns barScore: 0 = no bar, >0.22 = moderate bar, >0.35 = strong bar.
 *
 * @param {Float32Array} g      - Grayscale buffer.
 * @param {number}       w, h   - Dimensions.
 * @param {number}       cx, cy - Centroid.
 * @param {number}       re     - Half-light radius.
 * @returns {{ barScore, innerBA, outerBA, innerPA, outerPA, paDiff }}
 */
function detectBar(g, w, h, cx, cy, re) {
  const r1sq = (0.4 * re) * (0.4 * re); // inner ring boundary squared
  const r2sq = (1.5 * re) * (1.5 * re); // outer ring boundary squared

  let iMxx=0, iMyy=0, iMxy=0, iSw=0;
  let oMxx=0, oMyy=0, oMxy=0, oSw=0;

  for (let y = 0; y < h; y++) {
    const dy  = y - cy;
    const dySq = dy * dy;
    for (let x = 0; x < w; x++) {
      const v  = g[y * w + x];
      const dx = x - cx;
      const rSq = dx * dx + dySq;
      if (rSq < r1sq) {
        iMxx += dx*dx*v; iMyy += dy*dy*v; iMxy += dx*dy*v; iSw += v;
      } else if (rSq < r2sq) {
        oMxx += dx*dx*v; oMyy += dy*dy*v; oMxy += dx*dy*v; oSw += v;
      }
    }
  }

  if (iSw === 0 || oSw === 0) return { barScore:0, innerBA:1, outerBA:1, paDiff:0 };

  // Solve eigenvalues and PA for a moment tensor
  const solveMoments = (m, sw) => {
    const Mx=m.xx/sw, My=m.yy/sw, Mxy=m.xy/sw;
    const tr=Mx+My, det=Mx*My-Mxy*Mxy, disc=Math.sqrt(Math.max(0,tr*tr/4-det));
    const e1=tr/2+disc, e2=tr/2-disc;
    const ba = e1 > 0 ? Math.sqrt(Math.max(0,e2)) / Math.sqrt(e1) : 1;
    const pa = Math.atan2(2*Mxy, Mx-My) / 2 * (180/Math.PI);
    return { ba, pa: ((pa%180)+180)%180 };
  };

  const inner = solveMoments({ xx:iMxx, yy:iMyy, xy:iMxy }, iSw);
  const outer = solveMoments({ xx:oMxx, yy:oMyy, xy:oMxy }, oSw);

  // PA difference — use the smaller of the two possible angle differences
  const paDiff = Math.min(
    Math.abs(inner.pa - outer.pa),
    180 - Math.abs(inner.pa - outer.pa)
  );

  // Bar score: inner elongation weighted by PA alignment
  const elongation = 1 - inner.ba;
  const barScore =
    elongation > 0.25 && paDiff < 30 ? elongation * (1 - paDiff / 30) :
    elongation > 0.20 && paDiff < 40 ? elongation * 0.5 : 0;

  return { barScore, innerBA:inner.ba, outerBA:outer.ba,
           innerPA:inner.pa, outerPA:outer.pa, paDiff };
}

/**
 * Estimate spiral arm signal strength by analysing the angular distribution
 * of edge density at r ≈ 0.8·rₑ (where spiral arms are brightest).
 *
 * Two components:
 *   CV (coefficient of variation) — general angular non-uniformity.
 *   m=2 Fourier mode power — specifically detects two-armed spirals.
 *
 * spiralScore = 0.6·CV + 0.4·m2power
 *   > 0.5 → strong two-armed spiral
 *   0.35–0.5 → moderate spiral
 *   < 0.2 → elliptical / S0 / irregular
 *
 * Uses squared-distance comparisons for the ring filter, calling Math.sqrt()
 * only on pixels that pass the ring test (to compute their angle via atan2).
 *
 * @param {Float32Array} edges  - Sobel edge magnitude buffer.
 * @param {number}       w, h   - Dimensions.
 * @param {number}       cx, cy - Centroid.
 * @param {number}       re     - Half-light radius.
 * @returns {{ cv, m2power, spiralScore }}
 */
function spiralIndicator(edges, w, h, cx, cy, re) {
  const BINS    = 36;                  // 36 angular bins = 10° resolution
  const rTarget = 0.8 * re;           // ring radius where arms are sampled
  const rWidth  = re * 0.25;          // ring half-width

  // Pre-compute squared bounds so ring membership avoids sqrt for most pixels
  const rInSq  = (rTarget - rWidth) * (rTarget - rWidth);
  const rOutSq = (rTarget + rWidth) * (rTarget + rWidth);

  const bins   = new Float64Array(BINS);
  const counts = new Uint32Array(BINS);

  for (let y = 0; y < h; y++) {
    const dy   = y - cy;
    const dySq = dy * dy;
    // Quick row-level cull: entire row is outside the outer ring radius
    if (dySq > rOutSq) continue;
    for (let x = 0; x < w; x++) {
      const dx  = x - cx;
      const rSq = dx * dx + dySq;
      // Reject pixels outside the ring using squared comparison (no sqrt needed)
      if (rSq < rInSq || rSq > rOutSq) continue;

      // Only pixels inside the ring reach here — compute angle for binning
      const angle = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
      const b     = Math.floor(angle / (360 / BINS)) % BINS;
      bins[b]   += edges[y * w + x];
      counts[b] += 1;
    }
  }

  // Normalise each bin by its pixel count
  const norm = Array.from(bins, (v, i) => counts[i] > 0 ? v / counts[i] : 0);
  const mean = norm.reduce((a, b) => a + b, 0) / BINS;

  // CV = σ/μ (coefficient of variation — measures angular clumpiness)
  const variance = norm.reduce((a, b) => a + (b - mean) ** 2, 0) / BINS;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;

  // m=2 Fourier mode: DFT at spatial frequency 2 cycles per full circle
  // A strong m=2 component indicates two diametrically opposite arm peaks
  let re2 = 0, im2 = 0;
  for (let i = 0; i < BINS; i++) {
    const angle = 2 * Math.PI * 2 * i / BINS;
    re2 += norm[i] * Math.cos(angle);
    im2 += norm[i] * Math.sin(angle);
  }
  const m2power = Math.sqrt(re2*re2 + im2*im2) / (mean * BINS || 1);

  return { cv, m2power, spiralScore: cv * 0.6 + m2power * 0.4 };
}


/* ═══════════════════════════════════════════════════════════
   §15  PIXEL ANALYSIS — CLASSIFICATION DECISION TREE
   Uses the computed metrics to assign a Hubble type and
   simplified class. Evaluated in priority order:
     1. Irregular (high asymmetry overrides all)
     2. Elliptical (high Sérsic n, high C, low A/S)
     3. Lenticular S0 (intermediate n, no spiral/bar signal)
     4. Barred Spiral (bar score > threshold)
     5. Normal Spiral (catch-all disk galaxy)
═══════════════════════════════════════════════════════════ */

/**
 * @param {{ C, A, S, sersicN, ba, eps, barScore, spiralScore,
 *           innerBA, cv, m2power }} m  - Metric bundle.
 * @returns {{ simplified, hubble, confidence, notes }}
 */
function classify(m) {
  const { C, A, S, sersicN, ba, eps, barScore, spiralScore } = m;
  let simplified, hubble, confidence;
  const notes = [];

  /* ── 1. IRREGULAR ─────────────────────────────────────────
     Very high asymmetry or high asymmetry combined with low
     concentration. Disturbed/merger galaxies and dwarfs. */
  if (A > 0.42 || (A > 0.32 && C < 2.2)) {
    simplified = 'Irregular';
    hubble     = 'Irr';
    confidence = 50 + Math.round(Math.min(40, (A - 0.32) * 100));
    notes.push(`High asymmetry (A=${A.toFixed(3)}) indicates disturbed or irregular morphology`);
    if (C < 2.0) notes.push('Low concentration consistent with diffuse or dwarf irregular');
    return { simplified, hubble, confidence, notes };
  }

  /* ── 2. ELLIPTICAL ────────────────────────────────────────
     de Vaucouleurs-like profile (n≥3), high concentration,
     low asymmetry, no spiral signal. */
  if (sersicN >= 3.0 && C >= 3.0 && A < 0.15 && S < 0.2 && spiralScore < 0.35) {
    simplified  = 'Elliptical';
    const eClass = Math.min(7, Math.round(10 * eps)); // E0–E7 from ellipticity
    hubble      = 'E' + eClass;
    confidence  = 55 + Math.round((sersicN-3)*8 + (C-3)*10 + (0.15-A)*60);
    confidence  = Math.min(95, confidence);
    notes.push(`High Sérsic index (n=${sersicN.toFixed(1)}) indicates de Vaucouleurs-like profile`);
    notes.push(`Low asymmetry (A=${A.toFixed(3)}) and smooth texture consistent with elliptical`);
    if (C > 4.5) notes.push('Very high concentration — giant or cD elliptical candidate');
    return { simplified, hubble, confidence, notes };
  }

  /* ── 3. LENTICULAR (S0) ───────────────────────────────────
     Intermediate Sérsic n, moderate concentration, low asymmetry,
     no significant bar or spiral arm signal. */
  if (sersicN >= 2.0 && sersicN < 3.5 && C >= 2.5 && A < 0.18 && spiralScore < 0.3 && barScore < 0.25) {
    simplified = 'Lenticular';
    hubble     = ba < 0.7 ? 'S0a' : 'S0'; // S0a if noticeably flattened
    confidence = 45 + Math.round((C-2.5)*15 + (0.18-A)*50);
    confidence = Math.min(80, confidence);
    notes.push(`Intermediate Sérsic n=${sersicN.toFixed(1)} with smooth morphology`);
    notes.push('No significant spiral arm or bar signatures detected');
    return { simplified, hubble, confidence, notes };
  }

  /* ── 4 & 5. SPIRAL / BARRED SPIRAL ───────────────────────
     Catch-all: disk-dominated galaxy. Bar presence distinguishes
     SB from S. Sub-type (a→d) determined by C and Sérsic n:
       tight/bulge-dominated (a) ←→ open/disk-dominated (d) */
  const hasBar = barScore > 0.22;
  simplified   = hasBar ? 'Barred Spiral' : 'Spiral';

  let sub;
  if      (C > 3.3 || sersicN > 2.5) sub = 'a';
  else if (C > 2.7 || sersicN > 1.8) sub = 'ab';
  else if (C > 2.2 || sersicN > 1.2) sub = 'b';
  else if (C > 1.8 || sersicN > 0.9) sub = 'bc';
  else if (C > 1.4)                  sub = 'c';
  else                               sub = 'd';

  hubble     = (hasBar ? 'SB' : 'S') + sub;
  confidence = 50 + Math.round(
    (spiralScore > 0.3 ? 15 : 0) +
    (hasBar ? barScore * 30 : 0) +
    Math.min(20, (3.0 - Math.abs(sersicN - 1.5)) * 5)
  );
  confidence = Math.min(90, Math.max(35, confidence));

  if (hasBar) {
    notes.push(`Bar detected: inner elongation b/a=${m.innerBA?.toFixed(2)}, bar strength=${barScore.toFixed(2)}`);
  }
  notes.push(`Spiral arm signal: CV=${m.cv?.toFixed(2)}, m=2 mode power=${m.m2power?.toFixed(2)}`);
  notes.push(`Sérsic n=${sersicN.toFixed(1)} consistent with disk-dominated galaxy`);
  if (A > 0.2)  notes.push('Moderate asymmetry may indicate active star formation or minor interaction');
  if (S > 0.2)  notes.push(`Clumpiness S=${S.toFixed(2)} suggests patchy star-forming regions`);

  return { simplified, hubble, confidence, notes };
}


/* ═══════════════════════════════════════════════════════════
   §16  CANVAS RENDERING HELPERS (VISUALISATION STRIP)
   Functions that paint the four analysis canvases and the
   radial profile chart.
═══════════════════════════════════════════════════════════ */

/**
 * Paint a grayscale Float32 buffer to a named <canvas> element.
 * An optional mapping function transforms raw luminance to display value.
 * Also stores a reference to the last-rendered canvas for reuse by
 * renderIsoCanvas(), which needs the same background without reprocessing.
 *
 * @param {string}       id    - Canvas element id.
 * @param {Float32Array} g     - Source grayscale buffer.
 * @param {number}       w, h  - Image dimensions.
 * @param {Function}     [mapFn] - (value: number, index: number) → [0,255].
 *                                 If omitted, values are clamped as-is.
 */
let _lastGrayCanvas = null; // cached for renderIsoCanvas background reuse

function renderGrayCanvas(id, g, w, h, mapFn) {
  const cv = document.getElementById(id);
  if (!cv) return;
  cv.width = w; cv.height = h;
  const ctx  = cv.getContext('2d');
  const data = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = mapFn ? mapFn(g[i], i) : Math.min(255, g[i]);
    data.data[i*4]   = data.data[i*4+1] = data.data[i*4+2] = Math.round(v);
    data.data[i*4+3] = 255; // fully opaque
  }
  ctx.putImageData(data, 0, 0);
  // Cache the contrast-stretched canvas (id 'cv-contrast') for iso overlay reuse
  if (id === 'cv-contrast') _lastGrayCanvas = cv;
}

/**
 * Build an asinh contrast-stretch mapping function for a given pixel buffer.
 * The softening parameter a = peak/5 controls how aggressively the stretch
 * compresses bright features while revealing faint ones.
 * This is the same stretch used by many astronomical image viewers (e.g. DS9).
 *
 * @param {Float32Array} g   - Source buffer (used to find peak value only).
 * @returns {Function}       - (v: number) → [0, 255] display value.
 */
function asinhStretch(g) {
  let mx = 0;
  for (const v of g) if (v > mx) mx = v;
  const a = mx / 5; // softening parameter

  return (v) => {
    const stretched = Math.asinh(v / a) / Math.asinh(mx / a);
    return Math.round(Math.min(255, Math.max(0, stretched * 255)));
  };
}

/**
 * Render the isophote overlay canvas.
 * Draws the asinh-stretched galaxy image as background (reusing the already-
 * rendered contrast canvas via drawImage — no pixel rebuild needed), then
 * overlays:
 *   - Three concentric ellipses at r₂₀ (blue), rₑ (amber), r₈₀ (teal)
 *   - A centroid crosshair (amber)
 *   - A dashed line along the major axis (PA indicator)
 *
 * @param {string}       id             - Canvas element id.
 * @param {Float32Array} g              - Grayscale pixel buffer (kept for fallback).
 * @param {number}       w, h           - Image dimensions.
 * @param {number}       cx, cy         - Centroid.
 * @param {number}       axisA, axisB   - Semi-axes from second moments.
 * @param {number}       pa             - Position angle in degrees.
 * @param {number}       r20, r80       - Flux-enclosed radii (for ellipse scaling).
 */
function renderIsoCanvas(id, g, w, h, cx, cy, axisA, axisB, pa, r20, r80) {
  const cv = document.getElementById(id);
  if (!cv) return;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');

  // Background: reuse the already-rendered contrast canvas (a single drawImage
  // replaces the O(W×H) pixel-rebuild that was here before).
  if (_lastGrayCanvas && _lastGrayCanvas.width === w && _lastGrayCanvas.height === h) {
    ctx.drawImage(_lastGrayCanvas, 0, 0);
  } else {
    // Fallback: compute the stretch inline if the cached canvas is unavailable
    const mapFn = asinhStretch(g);
    const data  = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = mapFn(g[i]);
      data.data[i*4] = data.data[i*4+1] = data.data[i*4+2] = v;
      data.data[i*4+3] = 255;
    }
    ctx.putImageData(data, 0, 0);
  }

  const paRad = pa * Math.PI / 180;

  // Draw the three isophote ellipses
  const ellipseScales = [
    { s: r20 / axisA, color: 'rgba(55,138,221,0.7)',  lw: 1,   label: 'r₂₀' },
    { s: 1.0,          color: 'rgba(239,159,39,0.9)',  lw: 1.5, label: 'rₑ'  },
    { s: r80 / axisA, color: 'rgba(29,158,117,0.7)',  lw: 1,   label: 'r₈₀' },
  ];

  for (const { s, color, lw, label } of ellipseScales) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(paRad); // rotate coordinate system to align ellipse with PA
    ctx.beginPath();
    ctx.ellipse(0, 0, axisA * s, axisB * s, 0, 0, 2 * Math.PI);
    ctx.strokeStyle = color;
    ctx.lineWidth   = lw;
    ctx.stroke();
    ctx.restore();
    // Label near the right end of each ellipse
    ctx.fillStyle = color;
    ctx.font      = `${Math.max(9, w / 80)}px monospace`;
    ctx.fillText(label, cx + axisA * s * Math.cos(paRad) + 4, cy + axisA * s * Math.sin(paRad));
  }

  // Centroid crosshair
  const cs = Math.max(6, w / 60);
  ctx.strokeStyle = 'rgba(239,159,39,1)';
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(cx-cs, cy);  ctx.lineTo(cx+cs, cy);  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx,  cy-cs); ctx.lineTo(cx,  cy+cs); ctx.stroke();

  // Major axis PA line (dashed)
  const lineLen = axisA * 0.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(cx - lineLen * Math.sin(paRad), cy - lineLen * Math.cos(paRad));
  ctx.lineTo(cx + lineLen * Math.sin(paRad), cy + lineLen * Math.cos(paRad));
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * Draw the radial brightness profile chart.
 * X-axis: radius in pixels.  Y-axis: mean luminance (DN).
 * A dashed vertical line marks the half-light radius rₑ.
 *
 * @param {string}       id       - Canvas element id.
 * @param {Float64Array} profile  - Mean brightness per bin.
 * @param {number[]}     radii    - Bin mid-point radii.
 * @param {number}       re       - Half-light radius (for rₑ marker).
 */
function renderProfileCanvas(id, profile, radii, re) {
  const cv = document.getElementById(id);
  if (!cv) return;

  const W = cv.offsetWidth || 300;
  const H = 130;
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  ctx.fillStyle = '#050508';
  ctx.fillRect(0, 0, W, H);

  // Chart margins
  const pad = { l: 36, r: 14, t: 12, b: 28 };
  const cw  = W - pad.l - pad.r;
  const ch  = H - pad.t - pad.b;

  let maxV = 1;
  for (const v of profile) if (v > maxV) maxV = v;
  const maxR = radii[radii.length - 1];

  // Horizontal grid lines + Y-axis labels
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth   = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ch * (i / 4);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke();
    ctx.fillStyle  = 'rgba(255,255,255,.3)';
    ctx.font       = '9px monospace';
    ctx.textAlign  = 'right';
    ctx.fillText((maxV * (1 - i/4)).toFixed(0), pad.l - 3, y + 3);
  }

  // Vertical rₑ marker (dashed amber line)
  const reX = pad.l + (re / maxR) * cw;
  ctx.strokeStyle = 'rgba(239,159,39,.5)';
  ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(reX, pad.t); ctx.lineTo(reX, pad.t + ch); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(239,159,39,.7)';
  ctx.font      = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('rₑ', reX, pad.t - 2);

  // Brightness profile curve
  ctx.beginPath();
  for (let i = 0; i < profile.length; i++) {
    const x = pad.l + (radii[i] / maxR) * cw;
    const y = pad.t + ch * (1 - profile[i] / maxV);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(239,159,39,0.9)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Axis labels
  ctx.fillStyle = 'rgba(255,255,255,.4)';
  ctx.font      = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Radius (px)', pad.l + cw / 2, H - 4);
  ctx.save();
  ctx.translate(9, pad.t + ch / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Mean I', 0, 0);
  ctx.restore();
}


/* ═══════════════════════════════════════════════════════════
   §17  MAIN PIXEL ANALYSIS PIPELINE RUNNER
   Orchestrates all analysis steps in sequence.
   Calls yld() between heavy steps so the browser can repaint
   the console and canvases in real time.
═══════════════════════════════════════════════════════════ */

/**
 * Run the full pixel analysis pipeline on the currently selected image.
 * Steps in order:
 *   1.  Grayscale conversion (Rec.709 luminance)
 *   2.  Asinh contrast stretch visualisation
 *   3.  Brightness-weighted centroid
 *   4.  Second-moment ellipse (axis ratio, PA, ellipticity)
 *   5.  Radial brightness profile (64 annular bins)
 *   6.  Sérsic index fitting
 *   7.  Concentration index C
 *   8.  Asymmetry index A
 *   9.  Clumpiness index S (box blur residuals)
 *  10.  Sobel edge detection
 *  11.  Bar detection (inner/outer moment comparison)
 *  12.  Spiral arm indicator (angular edge density + m=2 Fourier)
 *  13.  Isophote overlay + profile chart rendering
 *  14.  Classification decision tree
 *  15.  Result rendering
 */
async function runPixelAnalysis() {
  if (!state.imgData) {
    showStatus('analyze-status', '⚠ Image pixel data not available. Try the Upload tab.', true);
    return;
  }

  document.getElementById('analysis-panel').classList.remove('hidden');
  document.getElementById('results-section').classList.add('hidden');
  clearConsole();
  hideStatus('analyze-status');

  const { imgData, imgW: W, imgH: H } = state;

  clog(`Image loaded: <span class="msg-metric">${W}×${H}px</span> (${(W*H).toLocaleString()} pixels)`, 'info');
  clog('Source: ' + esc(String(state.selectedTitle || '').slice(0, 80)), 'info');
  await yld();

  // ── Step 1: Grayscale + stats in one pass ──────────────────
  clog('Converting to luminance-weighted grayscale (Rec.709) and computing stats…', 'step');
  await yld();
  const g = toGray(imgData);
  let gmin = 255, gmax = 0, gsum = 0;
  for (const v of g) {
    if (v < gmin) gmin = v;
    if (v > gmax) gmax = v;
    gsum += v;
  }
  const gmean = gsum / g.length;
  let variance = 0;
  for (const v of g) variance += (v - gmean) ** 2;
  const gstd = Math.sqrt(variance / g.length);
  clogMetric('Luminance range', `${gmin.toFixed(1)} – ${gmax.toFixed(1)}`, 'DN');
  clogMetric('Mean brightness',  gmean.toFixed(2), 'DN');
  clogMetric('Std deviation',    gstd.toFixed(2),  'DN');
  renderGrayCanvas('cv-gray', g, W, H);
  clog('Grayscale render complete', 'ok');
  await yld();

  // ── Step 2: Contrast stretch ───────────────────────────────
  clog('Applying asinh contrast stretch (softening a = peak/5)…', 'step');
  await yld();
  const stretchFn = asinhStretch(g);
  renderGrayCanvas('cv-contrast', g, W, H, stretchFn);
  clog('Contrast stretch applied — low-surface-brightness features now visible', 'ok');
  await yld();

  // ── Steps 3 & 4 combined: Centroid + Second moments ────────
  // secondMoments() computes the centroid (first moments) in a sub-pass then
  // uses it for the centred second moments — one function call, two sub-passes,
  // no separate centroid() call needed.
  clog('Computing brightness-weighted centroid and fitting elliptical isophotes…', 'step');
  await yld();
  const { cx, cy, axisA, axisB, ba, pa, eps } = secondMoments(g, W, H);
  const offX = (cx - W/2).toFixed(1);
  const offY = (cy - H/2).toFixed(1);
  clogMetric('Centroid position', `(${cx.toFixed(1)}, ${cy.toFixed(1)})`, 'px');
  clogMetric('Offset from image centre', `Δx=${offX}, Δy=${offY}`, 'px');
  if (Math.abs(cx - W/2) > W * 0.15 || Math.abs(cy - H/2) > H * 0.15) {
    clog('⚠ Centroid far from image centre — galaxy may not be centred in the frame', 'warn');
  }
  const eClass = Math.min(7, Math.round(10 * eps));
  clogMetric('Semi-major axis a',  axisA.toFixed(1), 'px');
  clogMetric('Semi-minor axis b',  axisB.toFixed(1), 'px');
  clogMetric('Axis ratio (b/a)',   ba.toFixed(4));
  clogMetric('Ellipticity ε',      eps.toFixed(4));
  clogMetric('Position angle',     pa.toFixed(1) + '° (CCW from vertical)');
  clogMetric('Projected E-class',  'E' + eClass + ' (if elliptical)');
  await yld();

  // ── Step 5: Radial profile ─────────────────────────────────
  clog('Building radial brightness profile (64 annular bins)…', 'step');
  await yld();
  const BINS = 64;
  const { profile, radii, maxR, step } = radialProfile(g, W, H, cx, cy, BINS);
  clogMetric('Profile bins',         BINS);
  clogMetric('Bin width',            step.toFixed(1), 'px');
  clogMetric('Maximum radius',       maxR.toFixed(0), 'px');
  clogMetric('Peak brightness',      profile[0].toFixed(2), 'DN');
  clogMetric('Outer brightness',     profile[BINS-1].toFixed(2), 'DN');
  await yld();

  // Pre-compute total profile flux once — shared by sersicFit and concentration
  let totalFlux = 0;
  for (const v of profile) totalFlux += v;

  // ── Step 6: Sérsic fitting ─────────────────────────────────
  clog('Fitting Sérsic surface brightness profile…', 'step');
  await yld();
  const { n: sersicN, re, r2 } = sersicFit(profile, radii, totalFlux);
  clogMetric('Best-fit Sérsic index n', sersicN.toFixed(2));
  clogMetric('Half-light radius rₑ',   re.toFixed(1), 'px');
  clogMetric('Fit quality R²',          r2.toFixed(3));
  if      (sersicN >= 3.5) clog('n ≥ 3.5 → de Vaucouleurs profile — elliptical / bulge-dominated', 'data');
  else if (sersicN >= 2.0) clog('n ≈ 2–3 → intermediate bulge — S0 or early spiral', 'data');
  else if (sersicN >= 0.8) clog('n ≈ 1 → exponential disk — spiral galaxy', 'data');
  else                      clog('n < 0.8 → sub-exponential — late-type or irregular', 'data');
  await yld();

  // ── Step 7: Concentration ──────────────────────────────────
  clog('Computing concentration index C = 5·log₁₀(r₈₀ / r₂₀)…', 'step');
  await yld();
  const { C, r20, r80 } = concentration(profile, radii, totalFlux);
  clogMetric('r₂₀ (20% enclosed flux)', r20.toFixed(1), 'px');
  clogMetric('r₈₀ (80% enclosed flux)', r80.toFixed(1), 'px');
  clogMetric('Concentration C',          C.toFixed(3));
  if      (C > 4.5) clog('C > 4.5 → very high — giant / cD elliptical', 'data');
  else if (C > 3.5) clog('C > 3.5 → high — normal elliptical or Sa spiral', 'data');
  else if (C > 2.5) clog('C > 2.5 → moderate — Sb–Sc spiral', 'data');
  else if (C > 1.5) clog('C > 1.5 → low — Sc–Sd or irregular', 'data');
  else               clog('C < 1.5 → very low — diffuse irregular or dwarf', 'data');
  await yld();

  // ── Step 8: Asymmetry ──────────────────────────────────────
  clog('Computing asymmetry A (180° rotation residual)…', 'step');
  await yld();
  const A = asymmetry(g, W, H, cx, cy);
  clogMetric('Asymmetry A', A.toFixed(4));
  if      (A < 0.10) clog('A < 0.10 → symmetric — elliptical or regular disk', 'data');
  else if (A < 0.20) clog('A < 0.20 → mildly asymmetric — typical spiral', 'data');
  else if (A < 0.35) clog('A < 0.35 → moderately asymmetric — disturbed spiral or minor merger', 'data');
  else               clog('A > 0.35 → highly asymmetric — irregular or merger remnant', 'data');
  await yld();

  // ── Step 9: Clumpiness ─────────────────────────────────────
  clog('Computing clumpiness S (high-frequency residual flux)…', 'step');
  await yld();
  const blurRadius = Math.max(2, Math.round(re * 0.1));
  const blurred    = boxBlur(g, W, H, blurRadius);
  const S          = clumpiness(g, blurred, cx, cy, re, W, H);
  clogMetric('Box blur kernel radius', blurRadius, 'px');
  clogMetric('Clumpiness S', S.toFixed(4));
  if      (S < 0.05) clog('S < 0.05 → smooth — elliptical / S0', 'data');
  else if (S < 0.15) clog('S < 0.15 → moderate texture', 'data');
  else               clog('S > 0.15 → clumpy — active star formation likely', 'data');
  await yld();

  // ── Step 10: Edge detection (Sobel) ───────────────────────
  clog('Applying Sobel operator for edge / structure detection…', 'step');
  await yld();
  const edges = sobelEdges(g, W, H);
  let emax = 0;
  for (const v of edges) if (v > emax) emax = v;
  clogMetric('Peak edge response', emax.toFixed(1), 'DN/px');
  // Normalise and boost by ×2 so faint edges are visible
  renderGrayCanvas('cv-edge', edges, W, H, v => Math.min(255, v / emax * 255 * 2));
  clog('Sobel edge map rendered', 'ok');
  await yld();

  // ── Step 11: Bar detection ─────────────────────────────────
  clog('Testing for bar structure (inner vs. outer second moments)…', 'step');
  await yld();
  const barRes = detectBar(g, W, H, cx, cy, re);
  clogMetric('Inner axis ratio b/a',      (barRes.innerBA || 1).toFixed(3));
  clogMetric('Outer axis ratio b/a',      (barRes.outerBA || 1).toFixed(3));
  clogMetric('Inner–outer PA difference', (barRes.paDiff  || 0).toFixed(1), '°');
  clogMetric('Bar score',                  barRes.barScore.toFixed(3));
  if      (barRes.barScore > 0.35) clog('Strong bar signature detected', 'ok');
  else if (barRes.barScore > 0.22) clog('Moderate bar signature — SB or SAB class likely', 'data');
  else if (barRes.barScore > 0.10) clog('Weak bar or inner disc elongation', 'data');
  else                              clog('No significant bar detected', 'data');
  await yld();

  // ── Step 12: Spiral arm indicator ─────────────────────────
  clog('Analysing angular edge distribution for spiral arm signal…', 'step');
  await yld();
  const spiralRes = spiralIndicator(edges, W, H, cx, cy, re);
  clogMetric('Angular edge CV (coefficient of variation)', spiralRes.cv.toFixed(3));
  clogMetric('m=2 Fourier mode power',                     spiralRes.m2power.toFixed(3));
  clogMetric('Composite spiral score',                     spiralRes.spiralScore.toFixed(3));
  if      (spiralRes.spiralScore > 0.5)  clog('Strong two-armed spiral signal', 'ok');
  else if (spiralRes.spiralScore > 0.35) clog('Moderate spiral arm signal', 'data');
  else if (spiralRes.spiralScore > 0.2)  clog('Weak or multi-arm / flocculent spiral signal', 'data');
  else                                    clog('No significant spiral arm signal', 'data');
  await yld();

  // ── Step 13: Render visualisation overlays ────────────────
  clog('Rendering isophote ellipse overlay (r₂₀, rₑ, r₈₀)…', 'step');
  await yld();
  renderIsoCanvas('cv-iso', g, W, H, cx, cy, axisA, axisB, pa, r20, r80);
  renderProfileCanvas('cv-profile', profile, radii, re);
  clog('Visual overlays complete', 'ok');
  await yld();

  // ── Step 14: Classification ────────────────────────────────
  clog('——————————————————————————————', 'info');
  clog('Running classification decision tree…', 'step');
  await yld();

  const metrics = {
    C, A, S, sersicN, ba, eps,
    barScore:    barRes.barScore,
    innerBA:     barRes.innerBA,
    spiralScore: spiralRes.spiralScore,
    cv:          spiralRes.cv,
    m2power:     spiralRes.m2power,
  };
  const result = classify(metrics);
  await yld();

  clog('——————————————————————————————', 'info');
  clog(`Simplified class: <span class="msg-ok">${esc(result.simplified)}</span>`, 'ok');
  clog(`Hubble type:      <span class="msg-ok">${esc(result.hubble)}</span>`, 'ok');
  clog(`Confidence:       <span class="msg-metric">${result.confidence}%</span>`, 'ok');
  for (const note of result.notes) clog(esc(note), 'data');
  clog('Pipeline complete.', 'ok');

  // ── Step 15: Store result and render results panel ─────────
  state.pixelResult = {
    hubble:     result.hubble,
    simplified: result.simplified,
    confidence: result.confidence,
    notes:      result.notes,
    metrics:    { C, A, S, sersicN, ba, eps, pa, re, r20, r80,
                  barScore:    barRes.barScore,
                  spiralScore: spiralRes.spiralScore,
                  axisA, axisB, W, H, cx, cy },
  };

  renderPixelResults(state.pixelResult);
}


/* ═══════════════════════════════════════════════════════════
   §18  RESULTS RENDERER
   Populates every element in the #results-section with the
   values from the completed pixel analysis.
═══════════════════════════════════════════════════════════ */

/**
 * Populate the results panel with pixel analysis output.
 * @param {{ hubble, simplified, confidence, notes, metrics }} res
 */
function renderPixelResults(res) {
  const m = res.metrics;

  // ── Classification card ────────────────────────────────────
  document.getElementById('r-type').textContent = res.hubble;
  document.getElementById('r-name').textContent = res.simplified + ' Galaxy';

  const conf = Math.min(100, Math.max(0, res.confidence));
  document.getElementById('r-conf').textContent      = conf + '%';
  document.getElementById('r-conf-bar').style.width  = conf + '%';

  document.getElementById('r-method').textContent =
    'Method: Pixel analysis (centroid · second moments · Sérsic fitting · CAS · Sobel edges · bar/spiral detection)';

  // ── Hubble sequence chips ─────────────────────────────────
  const chips = document.getElementById('r-chips');
  chips.innerHTML = '';
  HUBBLE_SEQ.forEach(t => {
    const el = document.createElement('div');
    el.className = 'chip' + (t === res.hubble ? ' active' : '');
    el.textContent = t;
    chips.appendChild(el);
  });
  // If the classified type isn't in HUBBLE_SEQ (unusual types), append it
  if (!HUBBLE_SEQ.includes(res.hubble)) {
    const el = document.createElement('div');
    el.className   = 'chip active';
    el.textContent = res.hubble;
    chips.appendChild(el);
  }

  // ── NED catalog comparison ────────────────────────────────
  if (state.nedData) {
    const nedTypeMap = { G:'Galaxy', S:'Spiral', E:'Elliptical', I:'Irregular', QSO:'Quasar' };
    const nedT = state.nedData.type || '—';

    document.getElementById('cmp-px').textContent  = res.hubble + ' (' + res.simplified + ')';
    document.getElementById('cmp-ned').textContent = nedT + ' — ' + (nedTypeMap[nedT] || 'NED type');

    // Broad agreement check: pixel result and NED are "the same" if both are
    // elliptical-family or both are spiral-family
    const pxE = res.hubble.startsWith('E'), nedE = nedT === 'E' || nedT === 'G';
    const pxS = res.hubble.startsWith('S'), nedS = nedT === 'S';
    let verdict;
    if ((pxE && nedE) || (pxS && nedS)) {
      verdict = '<span class="pill pill-match">✓ Agreement</span> Pixel classification and NED catalog broadly agree.';
    } else if (nedT === 'G') {
      verdict = '<span class="pill pill-unknown">~ Unconstrained</span> NED only records "Galaxy" — pixel analysis provides morphological detail.';
    } else {
      verdict = '<span class="pill pill-diff">~ Discrepancy</span> Pixel result differs from NED. Image quality and wavelength affect classification.';
    }
    document.getElementById('cmp-verdict').innerHTML = verdict;
    document.getElementById('r-compare').classList.remove('hidden');
  } else {
    document.getElementById('r-compare').classList.add('hidden');
  }

  // ── Measurements table ────────────────────────────────────
  const rows = [
    ['Hubble type (full)',     res.hubble],
    ['Simplified class',      res.simplified],
    ['Axis ratio (b/a)',       m.ba.toFixed(4)],
    ['Ellipticity ε',          m.eps.toFixed(4)],
    ['Position angle',         m.pa.toFixed(1) + '°'],
    ['Semi-major axis',        m.axisA.toFixed(1) + ' px'],
    ['Half-light radius rₑ',   m.re.toFixed(1) + ' px'],
    ['r₂₀ (20% flux radius)',  m.r20.toFixed(1) + ' px'],
    ['r₈₀ (80% flux radius)',  m.r80.toFixed(1) + ' px'],
    ['Sérsic index n',         m.sersicN.toFixed(2)],
    ['Concentration C',        m.C.toFixed(3)],
    ['Asymmetry A',            m.A.toFixed(4)],
    ['Clumpiness S',           m.S.toFixed(4)],
    ['Bar score',              m.barScore.toFixed(3)],
    ['Spiral score',           m.spiralScore.toFixed(3)],
    ['Image size',             m.W + '×' + m.H + ' px'],
    ['Centroid',               `(${m.cx.toFixed(0)}, ${m.cy.toFixed(0)}) px`],
  ];

  const meas = document.getElementById('r-meas');
  meas.innerHTML = rows.map(([k, v]) =>
    `<div class="meas-row">` +
    `<span class="meas-k">${esc(k)}</span>` +
    `<span class="meas-v">${esc(v)}</span>` +
    `</div>`
  ).join('');

  // ── Features list ─────────────────────────────────────────
  const fl = document.getElementById('r-feats');
  fl.innerHTML = '';
  res.notes.forEach(n => {
    const li = document.createElement('li');
    li.textContent = String(n).slice(0, 200);
    fl.appendChild(li);
  });

  // ── CAS summary ───────────────────────────────────────────
  // Helper: convert a value to a qualitative label using threshold bins
  const casQual = (v, thresholds, labels) => {
    for (let i = 0; i < thresholds.length; i++) if (v < thresholds[i]) return labels[i];
    return labels[labels.length - 1];
  };

  const cQual = casQual(m.C, [2.0, 2.8, 3.8, 4.8], ['Very Low', 'Low', 'Moderate', 'High', 'Very High']);
  const aQual = casQual(m.A, [0.10, 0.20, 0.35],    ['Low', 'Moderate', 'High', 'Very High']);
  const sQual = casQual(m.S, [0.05, 0.12, 0.25],    ['Smooth', 'Moderate', 'Clumpy', 'Very Clumpy']);

  document.getElementById('r-cas').innerHTML =
    `C = <b>${m.C.toFixed(3)}</b> <span style="color:var(--text3)">(${esc(cQual)})</span><br>` +
    `A = <b>${m.A.toFixed(4)}</b> <span style="color:var(--text3)">(${esc(aQual)})</span><br>` +
    `S = <b>${m.S.toFixed(4)}</b> <span style="color:var(--text3)">(${esc(sQual)})</span><br>` +
    `n = <b>${m.sersicN.toFixed(2)}</b> <span style="color:var(--text3)">(Sérsic index)</span>`;

  // Show the results section and scroll to it
  document.getElementById('results-section').classList.remove('hidden');
  document.getElementById('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}


/* ═══════════════════════════════════════════════════════════
   §19  RESET / UTILITY
═══════════════════════════════════════════════════════════ */

/**
 * Toggle the raw JSON dump panel in the results section.
 * Populates the content from state.pixelResult on first open.
 */
function toggleRaw() {
  const el = document.getElementById('raw-json');
  if (!el.style.display || el.style.display === 'none') {
    el.textContent   = JSON.stringify(state.pixelResult, null, 2);
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

/**
 * Reset the entire application to its initial state.
 * Clears all selections, results, console, status messages,
 * and resets the analyze button. Called by "↩ Analyze another galaxy".
 */
function resetAll() {
  // Clear state
  Object.assign(state, {
    selectedUrl:    null,
    selectedTitle:  null,
    imgData:        null,
    imgW:           0,
    imgH:           0,
    selectedBase64: null,
    nedData:        null,
    pixelResult:    null,
  });

  // Hide all contextual panels
  ['analyze-section', 'analysis-panel', 'results-section'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );

  // Clear NASA grid and result cards
  document.getElementById('nasa-grid').innerHTML = '';

  // Reset the raw JSON toggle
  document.getElementById('raw-json').style.display = 'none';

  // Reset the file input (allows re-selecting the same file)
  document.getElementById('file-input').value = '';

  // Remove card selection highlights
  document.querySelectorAll('.img-card').forEach(c => c.classList.remove('selected'));

  // Clear all status messages
  ['nasa-status', 'analyze-status'].forEach(hideStatus);

  // Clear console log
  clearConsole();
}
