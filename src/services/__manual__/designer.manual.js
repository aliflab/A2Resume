/**
 * Manual checks for Designer (accent colour and font on top of a template).
 * Not imported by the app, not in the build. Run from the browser console with
 * the dev server up:
 *
 *   const d = await import('/src/services/__manual__/designer.manual.js');
 *   d.testDesignOffline();          // palette contrast, id resolution, persistence -- no DOM needed
 *   await d.testFontRoundTrips();   // 4 templates x 3 fonts x 4 fixtures, through pdfParser.js
 *   await d.testFontSweep();        // 4 templates x 3 fonts x 24 page-break offsets
 *   await d.testAccents();          // 4 templates x 7 accents: round trip + where the colour landed
 *   // on /designer, with a resume loaded:
 *   await d.liveDesign();           // real clicks; preview + download link rebuilt, blob checked, stored
 *   // reload, then:
 *   (await import('/src/services/__manual__/designer.manual.js')).verifyDesignSurvived();
 *
 * COVERAGE, AND WHY NOT THE FULL CARTESIAN PRODUCT
 * 4 templates x 8 accent settings x 4 font settings x 28 fixtures would be
 * 3,584 renders, and most of them would test nothing new:
 * - A FONT changes glyph widths, so it moves every line wrap and page break,
 *   and the name/contact gap that caught "Jane Doejane@x.io". Fonts therefore
 *   get the full treatment: every template, every font, every base fixture,
 *   and the whole 24-offset page-break sweep.
 * - An ACCENT changes a colour operator and nothing else -- no size, no
 *   metric, no position -- so it cannot move text. Accents get every template
 *   x every swatch on the sample fixture, which is enough to prove the round
 *   trip still passes AND to check where the colour actually landed (read back
 *   from pdf.js's operator list, not assumed).
 * - "Template default" for either choice is covered by templates.manual.js,
 *   and is byte-identical to the pre-Designer output (checked when the
 *   templates were made themeable).
 */

import { ACTIONS, appReducer, hydrate, initialState } from '../../context/AppContext.jsx';
import {
  ACCENT_CHOICES,
  ACCENT_MIN_CONTRAST,
  FONT_CHOICES,
  contrastRatio,
  resolveAccentChoice,
  resolveFontChoice,
  resolveResumeTheme,
} from '../../components/export/resumeDesign.js';
import { RESUME_TEMPLATES, RESUME_TEMPLATE_IDS, templateById } from '../../components/export/resumeTemplates.js';
import { extractTextFromPdf } from '../pdfParser.js';
import { normalizeResumeForExport } from '../resumeExport.js';
import { loadSession, saveSession } from '../sessionPersistence.js';
import { get, remove, set } from '../storageService.js';
import * as pdfjsLib from 'pdfjs-dist';
import { FIXTURES, SAMPLE, checkMagicBytes, renderTemplatePdf, roundTrip, testPageBreakSweep } from './templates.manual.js';

let results = [];
const check = (name, ok, detail) => {
  results.push(Boolean(ok));
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`, ok ? '' : (detail ?? ''));
};
const summary = () => {
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `FAIL: ${failed}/${results.length}` : `PASS: ${results.length}/${results.length}`);
  const ok = failed === 0;
  results = [];
  return ok;
};

// Same no-network pinning as pdfParser.js: reading a PDF back must not fetch.
const NO_REMOTE = { cMapUrl: null, standardFontDataUrl: null, iccUrl: null, wasmUrl: null };

// The colours each template draws with when no accent is chosen.
const OWN_COLOUR = { classic: '#999999', technical: '#888888', formal: '#777777', modern: '#1f5f7a' };

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

export function testDesignOffline() {
  for (const a of ACCENT_CHOICES) {
    const ratio = contrastRatio(a.hex);
    check(`palette: ${a.label} ${a.hex} is ${ratio.toFixed(2)}:1 on white (>= ${ACCENT_MIN_CONTRAST})`, ratio >= ACCENT_MIN_CONTRAST);
  }
  check('palette: ids are unique', new Set(ACCENT_CHOICES.map((a) => a.id)).size === ACCENT_CHOICES.length);
  check('fonts: exactly the three built-in PDF families', JSON.stringify(FONT_CHOICES.map((f) => f.id)) === '["helvetica","times","courier"]');
  check('fonts: every face is a react-pdf standard font name', FONT_CHOICES.every((f) => Object.values(f.faces).every((face) => /^(Helvetica|Times|Courier)(-|$)/.test(face))));
  check('templates: every defaultFont is a font choice', RESUME_TEMPLATES.every((t) => FONT_CHOICES.some((f) => f.id === t.defaultFont)));
  check('templates: accentUse is known for all four', RESUME_TEMPLATES.every((t) => ['rules', 'text'].includes(t.accentUse)));

  check('resolve: junk accent -> null (template own)', resolveAccentChoice('#ff0000') === null && resolveAccentChoice(42) === null);
  check('resolve: junk font -> null (template own)', resolveFontChoice('Comic Sans') === null && resolveFontChoice(undefined) === null);
  check('theme: no choice = the template family, no accent', (() => {
    const t = resolveResumeTheme('times', {});
    return t.faces.regular === 'Times-Roman' && t.accent === null;
  })());
  check('theme: a font choice overrides the template family', resolveResumeTheme('times', { font: 'courier' }).faces.bold === 'Courier-Bold');
  check('theme: an accent id resolves to its hex, never passed through raw', resolveResumeTheme('helvetica', { accent: 'navy' }).accent === '#1e3a8a' && resolveResumeTheme('helvetica', { accent: '#123456' }).accent === null);

  // Persistence -- the same path as the template choice.
  const before = get('session');
  try {
    const seeded = appReducer({ ...initialState, resumeText: 'x', resume: SAMPLE }, {
      type: ACTIONS.SET_SETTINGS,
      payload: { resumeAccent: 'burgundy', resumeFont: 'times', resumeTemplate: 'modern' },
    });
    check('SET_SETTINGS stores both ids next to the template', seeded.settings.resumeAccent === 'burgundy' && seeded.settings.resumeFont === 'times' && seeded.settings.resumeTemplate === 'modern');
    saveSession(seeded);
    const loaded = loadSession().state?.settings;
    check('saveSession -> loadSession keeps them', loaded?.resumeAccent === 'burgundy' && loaded?.resumeFont === 'times');
    check('hydrate restores them', hydrate(initialState).settings.resumeAccent === 'burgundy');
    check('CLEAR_ANALYSIS (a new Input run) keeps them', appReducer(seeded, { type: ACTIONS.CLEAR_ANALYSIS }).settings.resumeFont === 'times');
    const reset = appReducer(seeded, { type: ACTIONS.RESET }).settings;
    check('RESET (Start over) clears them', reset.resumeAccent === null && reset.resumeFont === null);
    set('session', { version: 1, state: { resumeText: 'x', settings: { resumeAccent: 7, resumeFont: { evil: true } } } });
    const junk = hydrate(initialState).settings;
    check('wrong-typed stored values are dropped by the flat sanitiser', junk.resumeAccent === null && junk.resumeFont === null);
  } finally {
    if (before === null) remove('session');
    else set('session', before);
  }
  return summary();
}

// ---------------------------------------------------------------------------
// Reading a PDF back
// ---------------------------------------------------------------------------

/** The standard-font names a PDF declares. Font dictionaries are not compressed, so this is a plain scan. */
export async function fontsIn(blob) {
  const text = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
  return [...new Set([...text.matchAll(/\/BaseFont\s*\/([A-Za-z-]+)/g)].map((m) => m[1]))].sort();
}

/** Every fill and stroke colour on page 1, as pdf.js reports it (hex). */
export async function coloursIn(blob) {
  // destroy() is on the loading task, not the document proxy (see pdfParser.js).
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), ...NO_REMOTE });
  const doc = await task.promise;
  try {
    const ops = await (await doc.getPage(1)).getOperatorList();
    const fill = new Set();
    const stroke = new Set();
    ops.fnArray.forEach((fn, i) => {
      if (fn === pdfjsLib.OPS.setFillRGBColor) fill.add(ops.argsArray[i][0]);
      if (fn === pdfjsLib.OPS.setStrokeRGBColor) stroke.add(ops.argsArray[i][0]);
    });
    return { fill: [...fill], stroke: [...stroke] };
  } finally {
    await task.destroy();
  }
}

// ---------------------------------------------------------------------------
// Fonts: every template x every font x every base fixture, then the sweep
// ---------------------------------------------------------------------------

export async function testFontRoundTrips({ fixtures = ['sample', 'heavy', 'sparse', 'unicode'] } = {}) {
  const rows = [];
  for (const templateId of RESUME_TEMPLATE_IDS) {
    for (const font of FONT_CHOICES) {
      const theme = resolveResumeTheme(templateById(templateId).defaultFont, { font: font.id });
      for (const fx of fixtures) {
        const r = await roundTrip(templateId, fx, { theme });
        const fonts = await fontsIn(r.blob);
        // react-pdf substitutes plain Helvetica for a glyph the chosen font
        // lacks. Measured, and not new: Formal as designed does it too. It is
        // allowed ONLY when the resume has characters no standard font can
        // draw (Export names those) -- a Helvetica face in an all-WinAnsi
        // resume would mean the theme did not reach some text.
        const fallbackAllowed = Boolean(r.unsupported);
        const foreign = fonts.filter((f) => !Object.values(font.faces).includes(f) && !(fallbackAllowed && f === 'Helvetica'));
        check(`${templateId} + ${font.label} / ${fx}: round trip`, r.ok, r.failures);
        check(`${templateId} + ${font.label} / ${fx}: declares only ${font.label} faces${fallbackAllowed ? ' (+ Helvetica fallback for undrawable characters)' : ''}`, foreign.length === 0, fonts);
        rows.push({ template: templateId, font: font.id, fixture: fx, ok: r.ok, pages: r.pages, fonts: fonts.join(' ') });
      }
    }
  }
  console.table(rows);
  // Pages per font on the heavy fixture, so the density cost of each font is on record.
  console.table(
    RESUME_TEMPLATE_IDS.map((t) => ({
      template: t,
      ...Object.fromEntries(FONT_CHOICES.map((f) => [f.id, rows.find((r) => r.template === t && r.font === f.id && r.fixture === 'heavy')?.pages])),
    })),
  );
  return { ok: summary(), rows };
}

export async function testFontSweep() {
  const out = [];
  for (const font of FONT_CHOICES) {
    const rows = await testPageBreakSweep({
      themeFor: (templateId) => resolveResumeTheme(templateById(templateId).defaultFont, { font: font.id }),
    });
    for (const row of rows) {
      check(`sweep ${row.template} + ${font.label}: ${row.runs - row.failed}/${row.runs} (pages ${row.pageCounts})`, row.failed === 0, row.detail);
      out.push({ font: font.id, ...row });
    }
  }
  console.table(out);
  return { ok: summary(), rows: out };
}

// ---------------------------------------------------------------------------
// Accents: every template x every swatch
// ---------------------------------------------------------------------------

export async function testAccents() {
  const rows = [];
  for (const templateId of RESUME_TEMPLATE_IDS) {
    const tpl = templateById(templateId);
    // The template as designed, first: its own colour is there.
    const own = await coloursIn(await renderTemplatePdf(templateId, normalizeResumeForExport(SAMPLE)));
    check(`${templateId} default: draws its own colour ${OWN_COLOUR[templateId]}`, [...own.fill, ...own.stroke].includes(OWN_COLOUR[templateId]), own);

    for (const a of ACCENT_CHOICES) {
      const theme = resolveResumeTheme(tpl.defaultFont, { accent: a.id });
      const r = await roundTrip(templateId, 'sample', { theme });
      const c = await coloursIn(r.blob);
      const all = [...c.fill, ...c.stroke];
      check(`${templateId} + ${a.label}: round trip`, r.ok, r.failures);
      check(`${templateId} + ${a.label}: the accent is drawn`, all.includes(a.hex), c);
      if (a.hex !== OWN_COLOUR[templateId]) {
        check(`${templateId} + ${a.label}: the template's own colour is gone (replaced, not added)`, !all.includes(OWN_COLOUR[templateId]), c);
      }
      if (tpl.accentUse === 'rules') {
        // Text is filled near-black; only the rule may carry the accent.
        // react-pdf draws borders as filled shapes, so the accent can appear
        // as a fill -- but never as the colour of the name.
        const nameFill = await nameColour(r.blob);
        check(`${templateId} + ${a.label}: the name stays near-black`, nameFill !== a.hex, nameFill);
      }
      rows.push({ template: templateId, accent: a.id, ok: r.ok, fills: c.fill.join(' '), strokes: c.stroke.join(' ') });
    }
  }
  console.table(rows);
  return { ok: summary(), rows };
}

/** The fill colour in force when the first text on page 1 (the name) is shown. */
async function nameColour(blob) {
  // destroy() is on the loading task, not the document proxy (see pdfParser.js).
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), ...NO_REMOTE });
  const doc = await task.promise;
  try {
    const ops = await (await doc.getPage(1)).getOperatorList();
    let fill = null;
    for (let i = 0; i < ops.fnArray.length; i += 1) {
      if (ops.fnArray[i] === pdfjsLib.OPS.setFillRGBColor) fill = ops.argsArray[i][0];
      if (ops.fnArray[i] === pdfjsLib.OPS.showText) return fill;
    }
    return fill;
  } finally {
    await task.destroy();
  }
}

// ---------------------------------------------------------------------------
// Live, on /designer
// ---------------------------------------------------------------------------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 20000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const value = predicate();
    if (value) return value;
    await wait(100);
  }
  return null;
}
const downloadHref = () => [...document.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Download PDF')?.href;
const frameSrc = () => document.querySelector('iframe.export__preview')?.src;
const storedSettings = () => {
  try {
    return JSON.parse(localStorage.getItem('a2resume:session'))?.state?.settings ?? null;
  } catch {
    return null;
  }
};

async function afterChange(act) {
  const beforeHref = downloadHref();
  const beforeFrame = frameSrc();
  await act();
  const href = await until(() => (downloadHref() && downloadHref() !== beforeHref ? downloadHref() : null));
  const frame = await until(() => (frameSrc() && frameSrc() !== beforeFrame ? frameSrc() : null));
  const blob = href ? await (await fetch(href)).blob() : null;
  return { href, frame, blob };
}

/**
 * Pick colours and fonts on the real page. After each change: the preview and
 * the download link were rebuilt, the download blob is a valid PDF drawn in
 * the chosen colour and font, and it round-trips through pdfParser.js with the
 * name on its own line. Leaves `leaveOn` selected for the reload check.
 */
export async function liveDesign({ steps, leaveOn = { accent: 'burgundy', font: 'times' } } = {}) {
  if (!location.pathname.startsWith('/designer')) throw new Error('Open /designer first.');
  const plan = steps ?? [
    { accent: 'navy' },
    { font: 'courier' },
    { accent: 'forest' },
    { font: 'helvetica' },
    { accent: null },
    { font: null },
    leaveOn,
  ];
  const rows = [];
  for (const step of plan) {
    const { blob, href, frame } = await afterChange(async () => {
      if ('accent' in step) document.querySelector(`input[name="designer-accent"][value="${step.accent ?? ''}"]`)?.click();
      if ('font' in step) {
        const select = document.getElementById('designer-font');
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(select, step.font ?? '');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    const settings = storedSettings();
    const tpl = templateById(settings?.resumeTemplate);
    const expectedFont = FONT_CHOICES.find((f) => f.id === (settings?.resumeFont ?? tpl.defaultFont));
    const expectedAccent = ACCENT_CHOICES.find((a) => a.id === settings?.resumeAccent)?.hex ?? OWN_COLOUR[tpl.id];
    const magic = blob ? await checkMagicBytes(blob) : { ok: false };
    const fonts = blob ? await fontsIn(blob) : [];
    const colours = blob ? await coloursIn(blob) : { fill: [], stroke: [] };
    const text = blob ? (await extractTextFromPdf(new File([blob], 'd.pdf', { type: 'application/pdf' }))).text : '';
    const row = {
      step: JSON.stringify(step),
      template: tpl.id,
      rebuilt: Boolean(href && frame),
      magic: magic.ok,
      fontOk: fonts.length > 0 && fonts.every((f) => Object.values(expectedFont.faces).includes(f)),
      fonts: fonts.join(' '),
      accentOk: [...colours.fill, ...colours.stroke].includes(expectedAccent),
      nameLine: text.split('\n')[0],
      stored: `${settings?.resumeAccent ?? 'default'} / ${settings?.resumeFont ?? 'default'}`,
    };
    row.ok = row.rebuilt && row.magic && row.fontOk && row.accentOk && row.nameLine === (FIXTURE_NAME() ?? row.nameLine);
    rows.push(row);
  }
  console.table(rows);
  console.log(rows.every((r) => r.ok) ? `PASS: ${rows.length} changes` : 'FAIL');
  return rows;
}

// The name the loaded session carries, so the header check does not assume a fixture.
const FIXTURE_NAME = () => window.a2resumeDev?.getState?.()?.tailoredResume?.name ?? window.a2resumeDev?.getState?.()?.resume?.name ?? null;

/** After a reload: storage, the page controls and the live store agree. */
export function verifyDesignSurvived(expected = { accent: 'burgundy', font: 'times' }) {
  const s = storedSettings();
  const checkedAccent = document.querySelector('input[name="designer-accent"]:checked')?.value ?? null;
  const selectedFont = document.getElementById('designer-font')?.value ?? null;
  const live = window.a2resumeDev?.getState?.()?.settings;
  const ok =
    s?.resumeAccent === expected.accent &&
    s?.resumeFont === expected.font &&
    checkedAccent === expected.accent &&
    selectedFont === expected.font &&
    live?.resumeAccent === expected.accent &&
    live?.resumeFont === expected.font;
  console.log(ok ? 'PASS' : 'FAIL', { expected, stored: s && { accent: s.resumeAccent, font: s.resumeFont }, checkedAccent, selectedFont, live: live && { accent: live.resumeAccent, font: live.resumeFont } });
  return ok;
}

export { FIXTURES };
