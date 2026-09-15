# A2Resume

A resume tool that runs entirely in your browser. No account, no server, no upload.

Give it your resume and the job posting you are targeting, and it parses both, scores the resume
the way an ATS would, shows you exactly which of the posting's keywords you match and which you
miss, and rewrites your bullets toward the role — never deleting a job, a date, or a skill, and
never inventing a number your resume does not already support.

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
that involves AI — parsing, analysis, tailoring — works without one.

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

The app is a four-step wizard. Every step is a normal route with no guard in front of it, so any
of them can be opened cold, bookmarked, or hard-refreshed; a step with no input shows an empty
state pointing back at the one that produces it.

### Step 1 — Input (`/input`)

Get a resume and a job description in, pick a provider, run the pipeline.

- **Resume**: drop a PDF (extracted in-browser via a locally bundled pdf.js worker) or paste text.
  Extracted text is always shown and always editable — PDF extraction interleaves multi-column
  layouts, and you are the only one who can fix that before parsing.
- **Job description**: paste it, or give a URL and let the app try to fetch it. Paste is always
  visible, because URL fetching fails on some boards by design (see
  [The two honest costs](#the-two-honest-costs)).
- **Provider**: the dropdown lists only providers you have stored a key for.

Submitting runs `runAnalysisPipeline`, four stages reported individually rather than behind one
spinner (the two AI calls are slow, the two local steps are instant):

1. Reading your resume
2. Reading the job description
3. Comparing against the role
4. Scoring for ATS

### Step 2 — Analyze (`/analyze`)

Read-only display of what came back.

- **ATS score** out of 100, across six criteria: keyword density match (35), top-third keyword
  placement (15), standard sections present and filled (15), XYZ-formula bullet quality (15), technical skill breadth
  (10), contact info parsability (10).
- **Keyword gaps**: every keyword the posting emphasises, classified as matched, partial (a synonym
  or near-neighbour appears — partial credit only), or missing, weighted by the posting's own
  priority.
- **A caution banner above the score** whenever the inputs were too thin to score properly. A low
  grade from a missing section and a low grade from a weak resume are different messages, and the
  number alone cannot tell them apart. Criteria that cannot be measured are excluded from the
  denominator rather than silently counted as zero.
- **Skill inference**, offered only when the resume lists few skills *and* describes real work.
  The model proposes skills your experience demonstrates but never names, each with a confidence
  level and a verbatim citation from your own text. Nothing is applied automatically — you approve
  items one at a time, approved ones are filed under a separate "Inferred from experience"
  category so they are never confused with what you actually wrote, and the score is then
  recomputed locally with no further AI call.

### Step 3 — Tailor (`/tailor`)

Runs the rewrite and shows every change next to its original.

This is the only service in the project that rewrites your words, so the discipline is split
across two layers on purpose:

1. The **prompt** demands additive-only editing — never delete an entry or a bullet, never touch a
   date or an employer or a title, never drop a link, treat skills as a union — and forbids
   inventing any metric the source does not support.
2. **`mergeNonDestructiveResume` enforces the structural half of that in code**, against the
   model's actual output, whether or not the prompt was followed. Dates, employment flags and
   links are taken from your original unconditionally; a dropped experience entry or project is
   restored in place; skills and contact links are unioned.

Anything the merge had to put back is surfaced in the UI, not hidden — if the safety net had to
act, that is worth knowing before you read the rest of the rewrite closely.

The tailored result is then **editable by hand**, one part at a time. The editable parts are:
- the header and contact links
- the summary
- skills: add, remove and move between categories
- every experience entry: bullets, dates, "I currently work here" and links
- projects
- education
- certifications

Edits go straight to Export and survive a reload. Discarding a tailoring pass you have edited asks
first and names the edits you would lose, because a fresh pass starts from your original resume.

### Step 4 — Export (`/export`)

Not built yet.

---

## Status

The pipeline from upload through tailoring works end to end. The pages past it do not exist.

| Area | State |
| --- | --- |
| Input (`/input`) | Built — PDF upload, paste, JD URL fetch, provider selection, staged pipeline |
| Analyze (`/analyze`) | Built — ATS score, gap breakdown, skill inference with approval gate |
| Tailor (`/tailor`) | Built — tailoring pass, hand editor for every section, before/after changes log, corrections notice |
| Settings (`/settings`) | Built — key storage per provider, Test Connection |
| Landing (`/`) | Built (minimal) |
| Export (`/export`) | Placeholder |
| Workspace (`/app`) | Placeholder — predates the wizard, kept but not part of it |
| Match (`/match`) | Placeholder |
| Cover Letter (`/cover-letter`) | Placeholder |
| Designer (`/designer`) | Placeholder |

All five AI providers are wired. PDF parsing, JD scraping, gap analysis and ATS scoring are
complete services with manual test runners.

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
  analytics, no error reporting, no proxying through a server we control. Any new network call has
  to justify itself against this rule.
- **One global store**: `useReducer` + Context in `src/context/AppContext.jsx`. No Redux, no
  Zustand.

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
the next rather than breaking the call, and fallback never crosses providers.

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

### How keys are handled

Keys live in `localStorage` under `a2resume_api_keys`, and the UI is built so a key value never
appears anywhere it could leak:

- A stored key is **never read into React state, never set as an input's `value`, and never
  rendered.** Settings knows only booleans — which providers have a key — from `getKeyPresence()`.
- A saved field shows a fixed-length mask as its *placeholder* plus a "Saved" badge. The mask is a
  constant, so not even the key's length is disclosed.
- There is no reveal toggle, on purpose. **Test Connection** answers the real question — does this
  key work? — better than reading the characters would, and it contacts exactly one host: the
  provider's own endpoint.
- Typing in a field replaces the stored key rather than editing it, and the draft leaves state the
  moment it is saved.

Choosing which provider to *use* is deliberately not done in Settings — that belongs to step 1,
next to the run button.

---

## Project structure

```
src/
  main.jsx                  Mounts AppProvider around RouterProvider
  router.jsx                The full route table; every route is a child of App
  App.jsx                   Layout shell only: header, <Outlet />, footer
  styles.css

  context/
    AppContext.jsx          The global store, the ACTIONS map, and useApp()

  pages/
    InputPage.jsx           Step 1 — upload/paste, JD fetch, provider, pipeline
    Analyze.jsx             Step 2 — score, gaps, skill-inference gate
    Tailor.jsx              Step 3 — tailoring pass and before/after log
    Export.jsx              Step 4 — placeholder
    Settings.jsx            API key storage and connection testing
    Landing.jsx             Landing page
    Workspace.jsx           Placeholder, predates the wizard
    Match.jsx               Placeholder
    CoverLetter.jsx         Placeholder
    Designer.jsx            Placeholder
    NotFound.jsx            404

  components/
    PagePlaceholder.jsx     Shared shell for the unbuilt pages

  services/
    aiService.js            Provider registry + the one orchestration loop
    apiKeyService.js        BYOK key storage; the only direct localStorage user
    storageService.js       get/set/remove over localStorage, `a2resume:` prefix

    pdfParser.js            PDF -> text in-browser, locally bundled worker
    jdScraper.js            Job posting URL -> clean text, via a proxy cascade

    resumeParser.js         Resume text -> structured object. Strict transcription
    jdParser.js             JD text -> structured object. Strict transcription
    skillInference.js       Infers skills from described work. Proposals only
    resumeTailor.js         The rewrite pass + the non-destructive merge

    gapAnalyzer.js          JD keyword vs resume classification. Pure, no network
    atsScorer.js            The 100-point ATS score. Pure, no network
    analysisPipeline.js     Chains the four analysis steps. React-free

    __manual__/             Console-run verification; not imported by the app

  utils/
    skillSynonyms.js        Skill-name equivalence groups
    actionVerbs.js          Strong resume verbs, weak-to-strong replacements
    jdKeywordExclusions.js  What a JD keyword must never be (perks, benefits, traits)
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
- **`pdfjs-dist` is imported dynamically** from the upload handler, which is what keeps it in its
  own chunk (440 kB raw / 132 kB gzip, plus a 1.2 MB worker) fetched only when someone actually
  opens a PDF, rather than in the 399 kB entry chunk every visitor downloads. A static import
  merges the two.
- **Word-boundary matching for skill names is hand-rolled on purpose.** `\b` is wrong in both
  directions and fails silently: `/\bC\b/` matches inside `C++`, and `/\bC\+\+\b/` never matches
  anything at all. Boundaries are defined by what may sit next to a term, and short alphabetic
  terms match case-sensitively so "we go to market" does not score as Go.

---

## Manual verification

There is no test runner. Each service layer ships a manual runner under
`src/services/__manual__/` — not imported by the app, not in the build — run from the browser
console with the dev server up.

**AI providers.** `testConnection` plus a trivial schema-constrained call per provider; keys print
masked.

```js
const t = await import('/src/services/__manual__/aiService.manual.js');
await t.runAll({ gemini: 'YOUR_KEY', openai: 'YOUR_KEY' });  // or t.runAll() to use stored keys
```

**Parsers.** Carries inline sample resume and JD text, and runs fidelity heuristics against the
source — urls captured, bullets captured, and any year in the output that never appeared in the
input (a strong invention signal).

```js
const p = await import('/src/services/__manual__/parsers.manual.js');
await p.runAll();
await p.testParsers('claude', 'KEY');
```

**Ingestion.** PDF extraction needs a real file and a real file needs a user gesture, so
`pickPdf()` has to be called from the console. Try a normal export, a two-column template, and a
scan — those three behave differently and are the only cases worth checking by hand.

```js
const t = await import('/src/services/__manual__/ingest.manual.js');
await t.pickPdf();         // file picker -> extract -> report
await t.testValidation();  // rejection paths, no real file needed
await t.testScraper();     // the live proxy chain against real postings
await t.probeProxies();    // each proxy in isolation: down vs. site-blocked
```

The sample JD URLs go stale. When one 404s, pull a fresh id from the board's public API.

**Analysis.** The first two runners are assertion-based and need **no provider, no key and no
network** — both modules under test are pure. They cover the boundary-matching cases (C vs C++ vs
C#, .NET, R vs R&D, Go vs "go to market") and 14 malformed input shapes.

```js
const a = await import('/src/services/__manual__/analysis.manual.js');
a.testOffline();
await a.testFullRun('claude', 'KEY');
await a.runAll();
```

`runAll` compares scores across providers. **A large spread means one parse dropped content, not
that the resume changed.**

**Tailoring.** `testMerge` is offline and asserts the non-destructive contract directly — it is the
one to run after any change to `mergeNonDestructiveResume`.

```js
const t = await import('/src/services/__manual__/tailor.manual.js');
t.testMerge();
await t.testLiveTailor('claude', 'KEY');
await t.runAll();
```

---

## Development

- **Lint must stay clean — zero warnings.** `.oxlintrc.json` disables `react/react-in-jsx-scope`
  (obsolete under the modern JSX transform) and `import/no-unassigned-import` (CSS side-effect
  imports are normal in Vite).
- The only inline suppression in the project is `import/default` on the `?url` pdf.js worker
  import in `pdfParser.js`, where oxlint cannot see past Vite's query suffix. Keep suppressions
  inline and targeted like that rather than widening the config.
- No test runner is configured. If you add one, document the single-test invocation here.

## License

MIT.
