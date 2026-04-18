/**
 * @fileoverview Client-side image-to-PDF converter with EN/PL localisation.
 *
 * Relies on jsPDF (loaded from CDN) for PDF generation.
 * All image data stays in-browser — nothing is sent to any server.
 *
 * Module structure:
 *  1. i18n        — translation map + setLang()
 *  2. State       — images array + dragId
 *  3. File input  — handleFiles(), drag-and-drop onto drop target
 *  4. Grid        — renderGrid(), removeImage()
 *  5. DnD reorder — onDragStart/Over/Leave/Drop/End
 *  6. Stats       — updateStats()
 *  7. PDF         — generatePdf(), reencodeImage()
 *  8. Helpers     — resolveOrientation, fitImage, pxToMm, progress, sleep, etc.
 *  9. Init        — wires mobile-bar button, calls setLang('en')
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
   1. i18n
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Translation map keyed by language code.
 * Values may be plain strings or functions that accept interpolation args.
 *
 * @type {Record<string, Record<string, string | ((...args: number[]) => string)>>}
 */
const TRANSLATIONS = {
    en: {
        tagline: 'All processing happens locally in your browser. No data leaves your device.',
        badge: '100% offline',
        dropTitle: 'Click to add images',
        dropSub: 'or drag & drop them here',
        emptyHint: 'Your images will appear here.<br />Drag to reorder.',
        sectionPage: 'Page settings',
        labelPageSize: 'Paper size',
        optFit: 'Fit to image',
        labelOrientation: 'Orientation',
        optAuto: 'Auto (per image)',
        optPortrait: 'Portrait',
        optLandscape: 'Landscape',
        labelMargin: 'Margin (mm)',
        labelQuality: 'Quality',
        qualHigh: 'High',
        qualMed: 'Medium',
        qualLow: 'Low',
        sectionOutput: 'Output',
        labelFilename: 'File name',
        labelOnePerPage: 'One image per page',
        sectionQueue: 'Queue',
        statImages: 'Images loaded',
        statSize: 'Total size',
        btnGenerate: 'Generate PDF',
        btnClear: 'Clear all',
        footerPowered: 'Powered by',
        progressStart: 'Starting\u2026',
        progressImg: (cur, total) => `Processing image ${cur} of ${total}\u2026`,
        progressDone: 'Done \u2014 saving\u2026',
        removeLabel: 'Remove',
    },
    pl: {
        tagline: 'Przetwarzanie odbywa si\u0119 lokalnie w przegl\u0105darce. \u017badne dane nie opuszczaj\u0105 urz\u0105dzenia.',
        badge: '100% offline',
        dropTitle: 'Kliknij, aby doda\u0107 zdj\u0119cia',
        dropSub: 'lub przeci\u0105gnij i upu\u015b\u0107 je tutaj',
        emptyHint: 'Twoje zdj\u0119cia pojawi\u0105 si\u0119 tutaj.<br />Przeci\u0105gaj, aby zmieni\u0107 kolejno\u015b\u0107.',
        sectionPage: 'Ustawienia strony',
        labelPageSize: 'Rozmiar strony',
        optFit: 'Dopasuj do zdj\u0119cia',
        labelOrientation: 'Orientacja',
        optAuto: 'Auto (per zdj\u0119cie)',
        optPortrait: 'Pionowa',
        optLandscape: 'Pozioma',
        labelMargin: 'Margines (mm)',
        labelQuality: 'Jako\u015b\u0107',
        qualHigh: 'Wysoka',
        qualMed: '\u015aredniak',
        qualLow: 'Niska',
        sectionOutput: 'Plik wynikowy',
        labelFilename: 'Nazwa pliku',
        labelOnePerPage: 'Jedno zdj\u0119cie na stron\u0119',
        sectionQueue: 'Kolejka',
        statImages: 'Wczytane zdj\u0119cia',
        statSize: '\u0141\u0105czny rozmiar',
        btnGenerate: 'Generuj PDF',
        btnClear: 'Wyczy\u015b\u0107 wszystko',
        footerPowered: 'Silnik:',
        progressStart: 'Uruchamianie\u2026',
        progressImg: (cur, total) => `Przetwarzanie zdj\u0119cia ${cur} z ${total}\u2026`,
        progressDone: 'Gotowe \u2014 zapisywanie\u2026',
        removeLabel: 'Usu\u0144',
    },
};

/** @type {'en'|'pl'} */
let currentLang = 'en';

/**
 * Returns the translated value for the given key in the current language,
 * falling back to English if the key is absent.
 *
 * @param {string}    key  - Translation key from TRANSLATIONS.
 * @param {...number} args - Forwarded to function-valued translations.
 * @returns {string}
 */
function t(key, ...args) {
    const dict = TRANSLATIONS[currentLang] ?? TRANSLATIONS['en'];
    const value = dict[key] ?? TRANSLATIONS['en'][key] ?? key;
    return typeof value === 'function' ? value(...args) : String(value);
}

/**
 * Switches the active language, re-translates all [data-i18n] nodes, and
 * re-renders the thumbnail grid (so dynamically built strings also update).
 *
 * Exported to window so the inline onclick="setLang(...)" in HTML works.
 *
 * @param {'en'|'pl'} lang - Target language code.
 * @returns {void}
 */
function setLang(lang) {
    currentLang = lang;
    document.documentElement.lang = lang;

    const btnEn = document.getElementById('lang-en');
    const btnPl = document.getElementById('lang-pl');
    if (btnEn) btnEn.classList.toggle('active', lang === 'en');
    if (btnPl) btnPl.classList.toggle('active', lang === 'pl');

    document.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.getAttribute('data-i18n') ?? '';
        const translated = t(key);
        // Use innerHTML only for strings that contain HTML tags (e.g. <br />).
        if (translated.includes('<')) {
            el.innerHTML = translated;
        } else {
            el.textContent = translated;
        }
    });

    // Re-render thumbnails so the remove-button title updates.
    renderGrid();
}

// Expose setLang globally for the onclick handlers in index.html.
window.setLang = setLang;

/* ═══════════════════════════════════════════════════════════════════
   2. State
   ═══════════════════════════════════════════════════════════════════ */

/**
 * @typedef  {object} ImageEntry
 * @property {string} id      - UUID assigned on load.
 * @property {File}   file    - Original File object.
 * @property {string} dataUrl - Base64 data-URL.
 * @property {string} name    - Original filename.
 * @property {number} size    - File size in bytes.
 */

/** @type {ImageEntry[]} */
let images = [];

/** @type {string|null} UUID of the card currently being dragged. */
let dragId = null;

/* ═══════════════════════════════════════════════════════════════════
   3. DOM refs
   ═══════════════════════════════════════════════════════════════════ */

const dropTarget = /** @type {HTMLElement}       */ (document.getElementById('drop-target'));
const fileInput = /** @type {HTMLInputElement}  */ (document.getElementById('file-input'));
const previewGrid = /** @type {HTMLElement}       */ (document.getElementById('preview-grid'));
const emptyState = /** @type {HTMLElement}       */ (document.getElementById('empty-state'));
const btnConvert = /** @type {HTMLButtonElement} */ (document.getElementById('btn-convert'));
const btnClear = /** @type {HTMLButtonElement} */ (document.getElementById('btn-clear'));
const btnConvertMobile = /** @type {HTMLButtonElement} */ (document.getElementById('btn-convert-mobile'));
const statCount = /** @type {HTMLElement}       */ (document.getElementById('stat-count'));
const statSize = /** @type {HTMLElement}       */ (document.getElementById('stat-size'));
const progressWrap = /** @type {HTMLElement}       */ (document.getElementById('progress-wrap'));
const progressFill = /** @type {HTMLElement}       */ (document.getElementById('progress-bar-fill'));
const progressLabel = /** @type {HTMLElement}       */ (document.getElementById('progress-label'));

/* ═══════════════════════════════════════════════════════════════════
   4. File input handling
   ═══════════════════════════════════════════════════════════════════ */

fileInput.addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    if (input.files) handleFiles(input.files);
});

dropTarget.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropTarget.classList.add('dragover');
});

dropTarget.addEventListener('dragleave', () => dropTarget.classList.remove('dragover'));

dropTarget.addEventListener('drop', (e) => {
    e.preventDefault();
    dropTarget.classList.remove('dragover');
    if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
});

/**
 * Reads a FileList, filters for image MIME types, converts each file to a
 * base64 data-URL via FileReader, and appends results to the `images` array.
 * Triggers a full grid re-render once all reads complete.
 *
 * @param {FileList} fileList - Raw files from an input or drag event.
 * @returns {void}
 */
function handleFiles(fileList) {
    const valid = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    if (!valid.length) return;

    let loaded = 0;

    valid.forEach((file) => {
        const reader = new FileReader();

        reader.onload = (ev) => {
            const result = ev.target?.result;
            if (typeof result === 'string') {
                images.push({
                    id: crypto.randomUUID(),
                    file,
                    dataUrl: result,
                    name: file.name,
                    size: file.size,
                });
            }
            if (++loaded === valid.length) renderGrid();
        };

        reader.readAsDataURL(file);
    });
}

/* ═══════════════════════════════════════════════════════════════════
   5. Thumbnail grid
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Re-renders the entire thumbnail grid from the current `images` state.
 * Also syncs the empty-state visibility, stats, and button disabled states.
 *
 * @returns {void}
 */
function renderGrid() {
    previewGrid.innerHTML = '';
    emptyState.style.display = images.length ? 'none' : 'flex';

    const disabled = images.length === 0;
    btnConvert.disabled = disabled;
    btnConvertMobile.disabled = disabled;

    images.forEach((img, index) => {
        const card = document.createElement('div');
        card.className = 'thumb-card';
        card.dataset['id'] = img.id;
        card.draggable = true;

        card.innerHTML = `
      <div class="thumb-order">${index + 1}</div>
      <img src="${img.dataUrl}" alt="${img.name}" loading="lazy" />
      <div class="thumb-footer">
        <span title="${img.name}">${truncate(img.name, 12)}</span>
        <button class="btn-remove" data-id="${img.id}" title="${t('removeLabel')}" aria-label="${t('removeLabel')}">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" width="12" height="12" aria-hidden="true">
              <line x1="2" y1="2" x2="10" y2="10"/>
              <line x1="10" y1="2" x2="2" y2="10"/>
            </svg>
          </button>
      </div>
    `;

        card.addEventListener('dragstart', onDragStart);
        card.addEventListener('dragover', onDragOver);
        card.addEventListener('dragleave', onDragLeave);
        card.addEventListener('drop', onDrop);
        card.addEventListener('dragend', onDragEnd);

        card.querySelector('.btn-remove')?.addEventListener('click', (e) => {
            e.stopPropagation();
            removeImage(img.id);
        });

        previewGrid.appendChild(card);
    });

    updateStats();
}

/**
 * Removes an image entry from state by UUID and re-renders the grid.
 *
 * @param {string} id - UUID of the image to remove.
 * @returns {void}
 */
function removeImage(id) {
    images = images.filter((img) => img.id !== id);
    renderGrid();
}

/* ═══════════════════════════════════════════════════════════════════
   6. Drag-and-drop reordering
   ═══════════════════════════════════════════════════════════════════ */

/** @param {DragEvent} e @returns {void} */
function onDragStart(e) {
    const card = /** @type {HTMLElement} */ (e.currentTarget);
    dragId = card.dataset['id'] ?? null;
    card.classList.add('dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

/** @param {DragEvent} e @returns {void} */
function onDragOver(e) {
    e.preventDefault();
    /** @type {HTMLElement} */ (e.currentTarget).classList.add('drag-over');
}

/** @param {DragEvent} e @returns {void} */
function onDragLeave(e) {
    /** @type {HTMLElement} */ (e.currentTarget).classList.remove('drag-over');
}

/** @param {DragEvent} e @returns {void} */
function onDrop(e) {
    e.preventDefault();
    const card = /** @type {HTMLElement} */ (e.currentTarget);
    const targetId = card.dataset['id'];
    card.classList.remove('drag-over');

    if (dragId && targetId && dragId !== targetId) {
        const fromIdx = images.findIndex((i) => i.id === dragId);
        const toIdx = images.findIndex((i) => i.id === targetId);
        if (fromIdx !== -1 && toIdx !== -1) {
            const [moved] = images.splice(fromIdx, 1);
            images.splice(toIdx, 0, moved);
            renderGrid();
        }
    }
}

/** @param {DragEvent} e @returns {void} */
function onDragEnd(e) {
    /** @type {HTMLElement} */ (e.currentTarget).classList.remove('dragging');
    dragId = null;
}

/* ═══════════════════════════════════════════════════════════════════
   7. Stats
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Updates the queue stat display (image count + total raw file size).
 *
 * @returns {void}
 */
function updateStats() {
    statCount.textContent = String(images.length);
    const total = images.reduce((acc, img) => acc + img.size, 0);
    statSize.textContent = images.length ? formatBytes(total) : '\u2014';
}

/* ═══════════════════════════════════════════════════════════════════
   8. Clear all
   ═══════════════════════════════════════════════════════════════════ */

btnClear.addEventListener('click', clearAll);

function clearAll() {
    images = [];
    fileInput.value = '';
    renderGrid();
}

/* ═══════════════════════════════════════════════════════════════════
   9. PDF generation
   ═══════════════════════════════════════════════════════════════════ */

btnConvert.addEventListener('click', generatePdf);
btnConvertMobile.addEventListener('click', generatePdf);

/**
 * Generates a PDF from the current `images` array using jsPDF.
 *
 * Each image is first re-encoded through an offscreen canvas at the selected
 * quality level, then placed on a PDF page. Progress is shown in the sidebar.
 * The resulting file triggers an automatic browser download.
 *
 * @async
 * @returns {Promise<void>}
 */
async function generatePdf() {
    if (!images.length) return;

    const pageSize = /** @type {HTMLSelectElement} */ (document.getElementById('page-size')).value;
    const orient = /** @type {HTMLSelectElement} */ (document.getElementById('orientation')).value;
    const margin = parseFloat(/** @type {HTMLInputElement}  */ (document.getElementById('margin')).value) || 0;
    const quality = parseFloat(/** @type {HTMLSelectElement} */ (document.getElementById('quality')).value);
    const onePerPage = /** @type {HTMLInputElement}  */ (document.getElementById('one-per-page')).checked;
    const rawName = /** @type {HTMLInputElement}  */ (document.getElementById('filename')).value.trim();
    const filename = (rawName || 'output').replace(/\.pdf$/i, '');

    setGenerating(true);
    showProgress(0, t('progressStart'));
    await sleep(50); // yield to browser before heavy synchronous work

    try {
        const {jsPDF} = /** @type {any} */ (window).jspdf;

        /**
         * jsPDF document instance — created on first image, never null afterwards.
         * @type {InstanceType<typeof jsPDF>|null}
         */
        let doc = null;

        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            showProgress(Math.round((i / images.length) * 100), t('progressImg', i + 1, images.length));

            // Re-encode via canvas to apply the quality / compression setting.
            const {dataUrl: encoded, width: imgW, height: imgH} =
                await reencodeImage(img.dataUrl, quality);

            const pageOrientation = resolveOrientation(orient, imgW, imgH);
            const jsPdfFormat = pageSize === 'fit' ? [pxToMm(imgW), pxToMm(imgH)] : pageSize;

            if (i === 0) {
                doc = new jsPDF({orientation: pageOrientation, unit: 'mm', format: jsPdfFormat});
            } else if (onePerPage) {
                doc.addPage(jsPdfFormat, pageOrientation);
            }
            // onePerPage === false → all images go onto the single first page.

            // doc is always non-null here (set at i === 0). Guard is for type safety.
            if (!doc) break;

            const pageW = doc.internal.pageSize.getWidth();
            const pageH = doc.internal.pageSize.getHeight();
            const areaW = pageW - margin * 2;
            const areaH = pageH - margin * 2;

            const {drawW, drawH} = fitImage(imgW, imgH, areaW, areaH);
            const x = margin + (areaW - drawW) / 2;
            const y = margin + (areaH - drawH) / 2;

            doc.addImage(encoded, 'JPEG', x, y, drawW, drawH, undefined, 'FAST', 0);

            await sleep(10); // yield between pages to keep UI responsive
        }

        showProgress(100, t('progressDone'));
        await sleep(100);
        doc?.save(`${filename}.pdf`);

    } catch (err) {
        console.error('[img\u2192pdf] PDF generation failed:', err);
        alert(err instanceof Error ? err.message : String(err));
    } finally {
        hideProgress();
        setGenerating(false);
    }
}

/**
 * Toggles the disabled state of both Generate buttons simultaneously.
 *
 * @param {boolean} isGenerating - True while PDF is being built.
 * @returns {void}
 */
function setGenerating(isGenerating) {
    btnConvert.disabled = isGenerating || images.length === 0;
    btnConvertMobile.disabled = isGenerating || images.length === 0;
}

/* ═══════════════════════════════════════════════════════════════════
   10. Helpers
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Re-encodes a source image through an offscreen <canvas> at the requested
 * JPEG quality. This is the actual compression mechanism — jsPDF otherwise
 * embeds images at full quality regardless of the quality option.
 *
 * @param {string} dataUrl  - Source image data-URL (any format the browser can decode).
 * @param {number} quality  - JPEG quality 0–1.
 * @returns {Promise<{dataUrl: string, width: number, height: number}>}
 */
function reencodeImage(dataUrl, quality) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error('Canvas 2D context unavailable'));
                return;
            }
            ctx.drawImage(img, 0, 0);
            resolve({
                dataUrl: canvas.toDataURL('image/jpeg', quality),
                width: img.naturalWidth,
                height: img.naturalHeight,
            });
        };
        img.onerror = () => reject(new Error('Failed to decode image for re-encoding'));
        img.src = dataUrl;
    });
}

/**
 * Resolves page orientation from user setting and image aspect ratio.
 *
 * @param {string} setting - 'auto' | 'portrait' | 'landscape'
 * @param {number} imgW    - Image width in pixels.
 * @param {number} imgH    - Image height in pixels.
 * @returns {'portrait'|'landscape'}
 */
function resolveOrientation(setting, imgW, imgH) {
    if (setting === 'portrait') return 'portrait';
    if (setting === 'landscape') return 'landscape';
    return imgW >= imgH ? 'landscape' : 'portrait';
}

/**
 * Scales image dimensions to fit inside a bounding box while preserving
 * the aspect ratio (object-fit: contain logic in mm space).
 *
 * @param {number} imgW - Original image width.
 * @param {number} imgH - Original image height.
 * @param {number} boxW - Available width.
 * @param {number} boxH - Available height.
 * @returns {{drawW: number, drawH: number}}
 */
function fitImage(imgW, imgH, boxW, boxH) {
    const ratio = Math.min(boxW / imgW, boxH / imgH);
    return {drawW: imgW * ratio, drawH: imgH * ratio};
}

/**
 * Converts a pixel value to millimetres, assuming a 96 DPI screen.
 *
 * @param {number} px - Pixel count.
 * @returns {number}
 */
function pxToMm(px) {
    return (px * 25.4) / 96;
}

/**
 * Shows the progress bar with updated fill and label.
 *
 * @param {number} pct   - Completion 0–100.
 * @param {string} label - Status text.
 * @returns {void}
 */
function showProgress(pct, label) {
    progressWrap.classList.add('visible');
    progressFill.style.width = `${pct}%`;
    progressLabel.textContent = label;
}

/**
 * Hides the progress bar and resets its fill.
 *
 * @returns {void}
 */
function hideProgress() {
    progressWrap.classList.remove('visible');
    progressFill.style.width = '0';
}

/**
 * Returns a Promise that resolves after `ms` milliseconds.
 * Used to yield execution back to the browser between heavy operations.
 *
 * @param {number} ms - Delay in milliseconds.
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Truncates a string to `max` characters and appends an ellipsis if needed.
 *
 * @param {string} str - Input string.
 * @param {number} max - Maximum allowed length.
 * @returns {string}
 */
function truncate(str, max) {
    return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}

/**
 * Formats a raw byte count into a human-readable string (B / KB / MB).
 *
 * @param {number} bytes - Raw byte count.
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
}

/* ═══════════════════════════════════════════════════════════════════
   11. Init
   ═══════════════════════════════════════════════════════════════════ */

// Detect browser language preference and set accordingly.
const prefersPl = navigator.language.toLowerCase().startsWith('pl');

// setLang populates all [data-i18n] nodes (including the tagline) for the
// first time. The HTML ships those nodes empty on purpose — no flash of
// wrong-language content.
setLang(prefersPl ? 'pl' : 'en');

// Initial grid render (shows empty state).
renderGrid();