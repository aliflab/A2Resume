# A2Resume

A resume tool that runs entirely in your browser. No account, no server, no upload.

Give it your resume and the job posting you are targeting, and it parses both, scores the resume
the way an ATS would, shows you exactly which of the posting's keywords you match and which you
miss, and rewrites your bullets toward the role — never deleting a job, a date, or a skill, and
never inventing a number your resume does not already support. Then it exports an ATS-safe PDF in
one of four templates, and can draft a grounded cover letter or rank your resume against several
postings at once.

The AI is bring-your-own-key. You paste a key from a provider you already pay for, it is stored in
your browser's `localStorage`, and requests go from your browser straight to that provider. There
is no backend of any kind in this project, so there is nowhere else for your resume to go.

---

## Quick start

```bash
npm install
npm run dev       # Vite dev server
```

Then open the app and go to **Settings** to paste an API key for at least one provider. Nothing
that involves AI — parsing, tailoring, cover letters, Match — works without one. Scoring, the hand
editor, Designer and PDF export are local and need no key.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the built `dist/` |
| `npm run lint` | oxlint (config: `.oxlintrc.json`) |

There is no test runner configured. See [Manual verification](#manual-verification) for how the
services are checked instead.

**Hosting a build:** routing is client-side via `createBrowserRouter`, so whatever serves `dist/`
must fall back to `index.html` for unknown paths. Any static host will do — there is no server
component to deploy.

---

## How it works

The core of the app is a four-step wizard, shown as a numbered track in the header: **Input →
Analyze → Tailor → Export**. A step whose output exists shows a check, and nothing is ever
disabled. Every step is a normal route with no guard in front of it, so any of them can be opened
cold, bookmarked, or hard-refreshed; a step with no input shows an empty state that says what is
missing and links to the step that produces it.

Beside the wizard sit three **tools** — Match, Cover Letter and Designer — and Settings.

### Step 1 — Input (`/input`)

Get a resume and a job description in, pick a provider, run the pipeline.

- **Resume**: drop a PDF (extracted in-browser via a locally bundled pdf.js worker, with
  page-by-page progress) or paste text. Extracted text is always shown and always editable — PDF
  extraction interleaves multi-column layouts, and you are the only one who can fix that before
  parsing.
- **Job description**: paste it, or give a URL and let the app try to fetch it. Paste is always
  visible, because URL fetching fails on some boards by design (see
  [The two honest costs](#the-two-honest-costs)). A failed fetch offers a button straight to the
  paste box.
- **Provider**: the dropdown lists only providers you have stored a key for.

Submitting runs `runAnalysisPipeline`, four stages reported individually rather than behind one
spinner (the two AI calls are slow, the two local steps are instant), with elapsed time and a
Cancel button:

1. Reading your resume
2. Reading the job description
3. Comparing against the role
4. Scoring for ATS

If the provider's first model is overloaded and the call falls through to the next one, the
active stage says so in plain words rather than sitting silent.

### Step 2 — Analyze (`/analyze`)

What came back, as a score ring, a verdict and a breakdown.

- **ATS score** out of 100, across six criteria: keyword density match (35), top-third keyword
  placement (15), standard sections present and filled (15), XYZ-formula bullet quality (15),
  technical skill breadth (10), contact info parsability (10). Each row carries a one-line
  description and "How this is measured".
- **Keyword coverage**: every keyword the posting emphasises, classified as matched, partial (a
  synonym or near-neighbour appears — partial credit only), or missing, weighted by the posting's
  own priority.
- **A caution banner above the score** whenever the inputs were too thin to score properly. A low
  grade from a missing section and a low grade from a weak resume are different messages, and the
  number alone cannot tell them apart. Criteria that cannot be measured are excluded from the
  denominator rather than silently counted as zero.
- **Before and after.** The score always describes the *current* resume — the tailored copy once
  one exists, with your hand edits and approved skills in it. After tailoring, the Input run's
  baseline is shown beside it with the keywords gained and lost.
- **Skill inference**, offered only when the resume lists few skills *and* describes real work.
  The model proposes skills your experience demonstrates but never names, each with a confidence
  level and a verbatim citation from your own text. Nothing is applied automatically — you approve
  items one at a time (there is no accept-all), approved ones are filed under a separate "Inferred
  from experience" category so they are never confused with what you actually wrote, and the score
  is then recomputed locally with no further AI call.

### Step 3 — Tailor (`/tailor`)

Runs the rewrite and shows every change next to its original.

This is the only service that rewrites your resume's words, so the discipline is split across two
layers on purpose:

1. The **prompt** demands additive-only editing — never delete an entry or a bullet, never touch a
   date or an employer or a title, never drop a link, treat skills as a union — and forbids
   inventing any metric the source does not support.
2. **`mergeNonDestructiveResume` enforces the structural half of that in code**, against the
   model's actual output, whether or not the prompt was followed. Dates, employment flags and
   links are taken from your original unconditionally; a dropped experience entry or project is
   restored in place; skills and contact links are unioned.

Anything the merge had to put back is surfaced in the UI, not hidden — if the safety net had to
act, that is worth knowing before you read the rest of the rewrite closely.

The tailored result is then **editable by hand**, one block at a time: the header and contact
links, the summary, skills, and every individual experience, project, education and certification
entry. Each block has Edit / Save / Cancel.

- **Whole entries can be added and removed.** Dropping an old, irrelevant role is often the most
  useful tailoring there is. Removal confirms inline, by name, and only touches the tailored copy.
  New experience and education entries go at the top (newest first); projects and certifications
  go at the end. There is no reordering yet.
- **Unsaved typing is autosaved** as a draft and offered back after a reload ("Saving draft…" /
  "Draft saved").
- **Every edit rescores immediately**, and a side panel shows the score delta, keywords gained and
  lost, and how many AI changes and hand edits are in play.
- Discarding an edited pass asks first and names every edit you would lose, because a fresh pass
  starts from your original resume.

### Step 4 — Export (`/export`)

"Your resume is ready": a summary card, a template picker, a live PDF preview, and the downloads.

- **The source is the current resume** — the tailored copy when one exists, otherwise the original
  parse — and the page says which.
- **Four templates**: Classic, Technical, Formal and Modern. All four keep the ATS guarantees: one
  column, sections in a fixed order under plain headings, real text in a standard PDF font, no
  images. Each is round-trip tested by rendering it and reading it back through the PDF extractor.
- **Download PDF**, **Download .txt**, and **Copy as plain text** for application forms with no
  upload. The `.txt` is built from a local Blob; nothing is fetched.
- **Characters the PDF fonts cannot draw are named in a warning**, rather than silently coming out
  wrong. The built-in fonts cover Windows-1252 only, so `→` or `東京` would otherwise be altered.
- The filename is `First_Last_Resume_YYYY-MM-DD.pdf` — about the candidate, not the tool.

---

## Tools

### Designer (`/designer`)

Accent colour and font, on top of whichever template you picked. **Nothing else** — there are no
layout, spacing or size controls, and the templates cannot receive any.

- **Colours** are a curated palette of seven, every one at least 7:1 against white. In Classic,
  Technical and Formal the accent only replaces the grey divider rules; in Modern it replaces the
  template's own teal on the name, headings and links. Text never turns colourful where the
  template had none.
- **Fonts** are Helvetica, Times and Courier — the three react-pdf ships without a font file, so
  choosing one fetches nothing. Courier costs extra pages, and the page says so.
- The choice is a standing preference, kept across new runs, and Export's download matches
  Designer's exactly.

### Match (`/match`)

One resume against up to ten job postings, ranked. Add each posting by pasting it or fetching its
URL, then run the batch.

- **No new AI capability.** Match is the same JD parse → gap analysis → ATS score chain the wizard
  runs, looped. Changing a scoring rule changes it everywhere.
- **N postings is N paid AI calls on your key**, and the run card states the count before you
  click. Calls run one at a time with per-posting progress; one posting failing does not discard
  the others' results, and a rejected key stops the batch on the first posting instead of failing
  ten times.
- Each row expands into the same keyword coverage view Analyze uses.
- **Stale results are flagged.** If the resume changes after a batch, a banner says the scores
  describe an earlier version and offers a re-run.

### Cover Letter (`/cover-letter`)

A letter written from the current resume and the analysed posting, in a chosen tone (Formal, Warm,
Concise) and length (Short, Medium, Long). It is shown as one editable plain-text body — exactly
what the PDF and the copy are built from — with a context panel of the role, your match, and the
posting's high-priority keywords.

This is the first thing in the app that writes **new prose with no per-item approval**, so it gets
the same two-layer treatment as the parser and the tailor:

1. The prompt forbids naming any employer, tool or skill the resume does not contain.
2. **`checkCoverLetterGrounding` checks the actual letter against the actual resume**, on
   generation and on every hand edit, and flags named things and tool names that appear nowhere
   in your resume. The posting's company and title are allowed; nothing else from the posting can
   vouch for a claim, and synonyms do not count.

The check is a term-presence test. A warning is strong evidence of a problem; a clean result is
weak evidence of correctness — it cannot catch a false claim written entirely in common words, or
an invented number. Read the letter before you send it.

Like Match, the letter is flagged as stale when the resume or the posting changes after it was
written. It exports as a one-page PDF in the same style as the resume.

---

## Status

Every route is built except the old Workspace placeholder.

| Area | State |
| --- | --- |
| Landing (`/`) | Built |
| Input (`/input`) | Built — PDF upload, paste, JD URL fetch, provider selection, staged pipeline with model-fallback notes |
| Analyze (`/analyze`) | Built — ATS score, before/after, keyword coverage, skill inference with approval gate |
| Tailor (`/tailor`) | Built — tailoring pass, block hand editor, add/remove entries, draft autosave, live rescoring |
| Export (`/export`) | Built — four templates, live preview, PDF / .txt / clipboard |
| Designer (`/designer`) | Built — accent colour and font over any template |
| Match (`/match`) | Built — up to 10 postings scored and ranked |
| Cover Letter (`/cover-letter`) | Built — tone, length, grounding check, PDF and copy |
| Settings (`/settings`) | Built — key storage per provider, Test Connection, data note |
| Workspace (`/app`) | Placeholder — predates the wizard, kept but nothing links to it |

All five AI providers are wired.

---

## Privacy and architecture

These are product decisions, not defaults, and most of the code's shape follows from them.

- **No backend.** No server, no API routes, no serverless functions, no database. The build is
  static files.
- **No accounts.** No login, no OAuth, no Firebase, no Supabase, no cloud sync. There is
  deliberately no auth affordance anywhere in the UI.
- **`localStorage` only.** Persistence goes through `src/services/storageService.js` (namespaced
  `a2resume:`). The one intentional exception is `apiKeyService.js`, which owns the single
  `a2resume_api_keys` entry directly.
- **Nothing is sent anywhere except the AI provider endpoints you configure.** No telemetry, no
  analytics, no error reporting, no proxying through a server we control, no web fonts, no icon
  CDN. Any new network call has to justify itself against this rule.
- **One global store**: `useReducer` + Context in `src/context/AppContext.jsx`. No Redux, no
  Zustand.

### Your session, saved in your browser

The whole pipeline — the input texts, the parses, the scores, the tailored resume and its edits,
unsaved drafts, the cover letter, Match results and your template and design choices — is saved
to one `a2resume:session` entry and restored on reload. API keys are stored separately and never
in the session.

- **Start over** in the header clears the session (after an inline confirmation) and leaves your
  API keys alone.
- A run in flight is never restored: a reload cannot leave a spinner that never stops.
- **A session saved by a different build is flagged.** If the scorer or a parser changed since your
  results were computed, a notice above the page lists which results were not recomputed. A
  session that cannot be read at all is discarded and the notice says so, rather than failing
  silently.
- If a save fails (storage full or blocked), the header says "Not saved" and the old snapshot is
  removed, so an older session never silently stands in for newer work.

### The two honest costs

Running with no backend is not free, and the code says so out loud in both places where it costs
something:

- **pdf.js must not phone home.** Left to itself, PDF.js guesses a worker location and several of
  its guesses are CDNs. The worker is imported as a Vite asset URL so it is emitted into
  `dist/assets/` and served same-origin, and `cMapUrl` / `standardFontDataUrl` / `iccUrl` /
  `wasmUrl` are all pinned to `null` so a future library default cannot quietly open a socket. The
  price is that PDFs using predefined CJK encodings extract as garbage unless you copy the cmaps
  into `public/` yourself.
- **Job boards do not send CORS headers**, so a browser cannot fetch a posting directly. Standing
  in for a backend is a cascade of free public proxies, tried in order, capped at 45 seconds for
  the whole chain. It works well on Greenhouse, Lever and Ashby and fails reliably on LinkedIn,
  Indeed and Glassdoor. A 200 OK is not treated as success — the response body is inspected for
  login walls and bot checks, because feeding a sign-in page to a strict transcriber produces a
  confident wrong answer, which is worse than failing. **Pasting the JD is the reliable path; URL
  fetching is a convenience on top of it.**

---

## AI providers

All five are wired. Model IDs are ordered fallback lists — a stale entry 404s and falls through to
the next rather than breaking the call. A temporarily overloaded model (503, or Anthropic's 529)
also falls through to the next one; other 5xx errors surface immediately. Fallback never crosses
providers.

| Provider | Endpoint | Structured output |
| --- | --- | --- |
| Claude | `api.anthropic.com/v1/messages` | `output_config.format` |
| OpenAI | `api.openai.com/v1/chat/completions` | `json_schema`, strict |
| Google Gemini | `generativelanguage.googleapis.com` | `responseSchema` |
| Kimi | `api.moonshot.ai/v1/chat/completions` | `json_schema`, strict |
| DeepSeek | `api.deepseek.com/v1/chat/completions` | `json_object` — schema folded into the prompt |

Adding a provider means adding one entry to the registry in `src/services/aiService.js`. Providers
own no control flow: the timeout, model fallback, 429 backoff and error classification all live in
one shared loop.

**Effort is set per call, cheapest by default.** Every thinking token is spent on your key, so on
Claude the parses run at `low` effort and tailoring, skill inference and cover letters at
`medium`. Other providers ignore the hint.

### How keys are handled

Keys live in `localStorage` under `a2resume_api_keys`, and the UI is built so a key value never
appears anywhere it could leak:

- A stored key is **never read into React state, never set as an input's `value`, and never
  rendered.** Settings knows only booleans — which providers have a key — from `getKeyPresence()`.
- A saved field shows a fixed-length mask as its *placeholder* plus a "Configured" badge. The mask
  is a constant, so not even the key's length is disclosed.
- There is no reveal toggle, on purpose. **Test connection** answers the real question — does this
  key work? — better than reading the characters would, and it contacts exactly one host: the
  provider's own endpoint.
- Typing in a field replaces the stored key rather than editing it, and the draft leaves state the
  moment it is saved.

Choosing which provider to *use* is deliberately not done in Settings — that belongs to step 1,
next to the run button.

---

## Interface

- **Themes:** System, Light, Dim and Dark, from the toggle in the header. System follows the OS
  live with no script involved; the choice is stored beside the session, so Start over keeps it.
  The PDF preview stays white paper in every theme.
- **Every wait says what is happening.** Where the code knows real progress it shows it (PDF pages
  read, proxy n of 5, postings scored); where it cannot, it shows an indeterminate bar and elapsed
  seconds rather than a fake percentage. `prefers-reduced-motion` switches all animation off.
- **No icon package and no web fonts.** Icons are inline SVG in `src/components/Icon.jsx`.
- Layouts work down to phone width; below 40rem the wizard becomes a compact grid and Input's run
  bar sticks to the bottom.

---

## Project structure

```
src/
  main.jsx                  Mounts AppProvider around RouterProvider; applies the theme
  router.jsx                The full route table; every route is a child of App
  routeChunks.js            Loaders for lazy routes, shared with the pages that prefetch them
  App.jsx                   Layout shell: header (wizard, tools, settings), <Outlet />, footer
  styles.css                Design tokens, themes, primitives, page styles

  context/
    AppContext.jsx          The global store, the ACTIONS map, and useApp()

  pages/
    Landing.jsx             Landing page
    InputPage.jsx           Step 1 — upload/paste, JD fetch, provider, pipeline
    Analyze.jsx             Step 2 — score, before/after, gaps, skill-inference gate
    Tailor.jsx              Step 3 — tailoring pass, hand editor, changes log   (lazy)
    Export.jsx              Step 4 — templates, preview, PDF / .txt / copy
    Designer.jsx            Accent colour and font                             (lazy)
    Match.jsx               One resume vs several postings                     (lazy)
    CoverLetter.jsx         Grounded cover letter                              (lazy)
    Settings.jsx            API key storage and connection testing
    Workspace.jsx           Placeholder, predates the wizard
    NotFound.jsx            404

  components/
    Icon.jsx                Inline SVG icon set
    LazyPage.jsx            Loading and chunk-failure states around lazy routes
    ThemeToggle.jsx         System / Light / Dim / Dark
    ui/                     PageHeader, EmptyState, ErrorNotice, ScoreRing, Spinner,
                            WorkingLine, FetchProgress, PreviewSkeleton, scoreBands
    analysis/
      KeywordCoverage.jsx   Matched / partial / missing view, shared by Analyze and Match
    tailor/
      TailoredResumeEditor.jsx  The block hand editor
    export/
      PdfPreview.jsx        The only module that imports react-pdf (lazy)
      ResumeDocument.jsx    Classic template
      TechnicalResumeDocument.jsx, FormalResumeDocument.jsx, ModernResumeDocument.jsx
      CoverLetterDocument.jsx   The cover letter PDF
      pdfParts.jsx          Shared template parts (page-break grouping, no hyphenation)
      TemplatePicker.jsx    Template radio group, used by Export and Designer
      resumeTemplates.js    Template catalogue (no react-pdf; safe anywhere)
      resumeDesign.js       Designer's colour and font catalogue (same rule)
      resumeDocuments.js    Template id -> component map (lazy side only)

  services/
    aiService.js            Provider registry + the one orchestration loop
    apiKeyService.js        BYOK key storage; the only direct localStorage user
    storageService.js       get/set/remove over localStorage, `a2resume:` prefix
    sessionPersistence.js   The pipeline <-> one localStorage entry. Never throws
    themeService.js         Theme preference

    pdfParser.js            PDF -> text in-browser, locally bundled worker
    jdScraper.js            Job posting URL -> clean text, via a proxy cascade

    resumeParser.js         Resume text -> structured object. Strict transcription
    jdParser.js             JD text -> structured object. Strict transcription
    skillInference.js       Infers skills from described work. Proposals only
    resumeTailor.js         The rewrite pass + the non-destructive merge
    tailoredEdits.js        Drafts, commits, add/remove and the hand-edit log
    coverLetterGenerator.js Resume + JD -> letter, plus a grounding report
    coverLetterExport.js    Letter -> the shape the PDF and copy read
    matchRunner.js          The JD parse -> gap -> score chain, looped over postings

    gapAnalyzer.js          JD keyword vs resume classification. Pure, no network
    atsScorer.js            The 100-point ATS score. Pure, no network
    currentResume.js        Which resume is "current", and rescoring it. Pure
    analysisPipeline.js     Chains the four analysis steps. React-free
    resumeExport.js         Resume -> normalised export shape, plain text, filename

    __manual__/             Console-run verification; not imported by the app

  utils/
    skillSynonyms.js        Skill-name equivalence groups
    actionVerbs.js          Strong resume verbs, weak-to-strong replacements
    jdKeywordExclusions.js  What a JD keyword must never be (perks, benefits, traits)
    transcriptionFidelity.js  Catches words altered while the parser copied them
    coverLetterGrounding.js   Flags names and tools in a letter that the resume lacks
    artefactFingerprint.js    Stable hash used to detect stale letters and Match results
    errorMessages.js        Typed errors -> user-facing text
    uploadLimits.js         Upload caps, split out to keep pdf.js out of the bundle
```

### Design notes worth knowing before editing

- **`gapAnalyzer.js` and `atsScorer.js` are pure and deterministic.** No provider, no key, no
  network. Running them twice on the same input must give the same answer.
- **Parsed objects arrive with keys missing.** Not every provider guarantees every schema key, and
  DeepSeek's JSON mode enforces no schema at all. Every read in the analysis services goes through
  `asArray` / `asString` / `asObject` guards. A missing field must produce a lower score, never a
  throw.
- **Parsing and inference are different operations and must never share a prompt.** The parser's
  "never invent" rule is load-bearing precisely because nobody reviews its output; the inference
  prompt is softer, and that is safe *only* because a human approves each item.
- **Every generative step has a code-level backstop behind its prompt** — the non-destructive
  merge for tailoring, `transcriptionFidelity` for the parser (it caught "customer service" being
  copied as "retail"), and `coverLetterGrounding` for letters. A prompt instruction alone has
  already been shown not to hold across providers.
- **Heavy code loads on demand.** pdf.js is imported from the upload handler, react-pdf only
  inside the lazy `PdfPreview`, and the Tailor, Match, Cover Letter and Designer pages are
  `React.lazy` routes (Analyze prefetches Tailor so the wizard never waits between steps). The
  entry chunk is about 469 kB raw / 152 kB gzip; the PDF chunk's size warning is expected.
- **Never `Font.register` a remote URL** in a PDF template, Google Fonts included — react-pdf
  would `fetch` it, which breaks the no-network rule.
- **Word-boundary matching for skill names is hand-rolled on purpose.** `\b` is wrong in both
  directions and fails silently: `/\bC\b/` matches inside `C++`, and `/\bC\+\+\b/` never matches
  anything at all. Boundaries are defined by what may sit next to a term, and short alphabetic
  terms match case-sensitively so "we go to market" does not score as Go.

`CLAUDE.md` holds the full design record, including what was measured and when.

---

## Manual verification

There is no test runner. Each service layer ships a manual runner under
`src/services/__manual__/` — not imported by the app, not in the build — run from the browser
console with the dev server up. Runners named `testOffline` (and most `test*` runners) need **no
provider, no key and no network**. Runners named `live*` drive the real page and **mutate whatever
session is loaded**, so run them on test data.

| Runner | Covers |
| --- | --- |
| `aiService.manual.js` | `testConnection` and a schema-constrained call per provider; keys print masked |
| `effort.manual.js` | The effort level on the wire (offline), and a paid high-vs-low comparison |
| `parsers.manual.js` | Resume and JD parsing with fidelity heuristics against the source |
| `ingest.manual.js` | PDF extraction (`pickPdf()` needs a real file) and the live proxy chain |
| `analysis.manual.js` | Boundary matching (C vs C++ vs C#, R vs R&D, Go vs "go to market") and 14 malformed inputs |
| `tailor.manual.js` | The non-destructive merge — run `testMerge()` after any change to it |
| `tailorEditor.manual.js` | The hand editor, add/remove entries, index drift, drafts, live round trips with reloads |
| `pipeline.manual.js` | That the score always follows the current resume, across every action |
| `session.manual.js` | Persistence edge cases; snapshot → reload → verify |
| `templates.manual.js` | Every template rendered and read back; a 24-length page-break sweep |
| `designer.manual.js` | Fonts and colours per template, contrast, persistence |
| `match.manual.js` | Batch logic, staleness, removal, a live run |
| `coverLetter.manual.js` | Grounding, staleness, an injected fabrication, a live generation |

```js
const a = await import('/src/services/__manual__/analysis.manual.js');
a.testOffline();
await a.testFullRun('claude', 'KEY');
await a.runAll();     // compares scores across every provider with a stored key
```

Two things worth knowing:

- **A large score spread across providers means one parse dropped content**, not that the resume
  changed.
- **For PDF templates, run the page-break sweep, not just the fixtures.** The heavy fixture passed
  with a stranded-heading bug present; only the sweep found it.

The sample JD URLs in `ingest.manual.js` go stale. When one 404s, pull a fresh id from the board's
public API.

---

## Development

- **Lint must stay clean — zero warnings.** `.oxlintrc.json` disables `react/react-in-jsx-scope`
  (obsolete under the modern JSX transform) and `import/no-unassigned-import` (CSS side-effect
  imports are normal in Vite).
- The only inline suppression in the project is `import/default` on the `?url` pdf.js worker
  import in `pdfParser.js`, where oxlint cannot see past Vite's query suffix. Keep suppressions
  inline and targeted like that rather than widening the config.
- **Saving `AppContext.jsx` forces a full page reload in dev** (Vite cannot fast-refresh a module
  that also exports `ACTIONS`); session persistence carries the store through it.
- No test runner is configured. If you add one, document the single-test invocation here.

## License

MIT.
