# A2Resume

**Live app: [a2resume.vercel.app](https://a2resume.vercel.app/)**

A resume tool that runs entirely in your browser. No account, no server, no upload.

Give it your resume and a job posting. It parses both, scores the resume the way an ATS would,
shows which of the posting's keywords you match and miss, and rewrites your bullets toward the
role without deleting a job, date or skill, and without inventing numbers. Then it exports an
ATS-safe PDF, drafts a grounded cover letter, or ranks your resume against several postings.

The AI is **bring-your-own-key**. Your key is stored in your browser's `localStorage`, and
requests go straight from your browser to the provider you chose. There is no backend, so there
is nowhere else for your resume to go.

## Quick start

```bash
npm install
npm run dev
```

Open **Settings** and add an API key for at least one provider. Parsing, tailoring, cover letters
and Match need a key. Scoring, the hand editor, Designer and PDF export run locally without one.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the built `dist/` |
| `npm run lint` | oxlint (zero warnings) |

Routing is client-side, so any static host must fall back to `index.html` for unknown paths.
`vercel.json` does this for Vercel.

## Features

**The wizard: Input → Analyze → Tailor → Export.** Every step is a plain route you can open
cold. A step with nothing to show says what is missing and links to the step that produces it.

- **Input:** upload a PDF (extracted in-browser) or paste text, and paste a job description or
  fetch it from a URL. Extracted text stays visible and editable.
- **Analyze:** an ATS score out of 100 across six criteria, keyword coverage (matched / partial /
  missing), and a caution banner when the input was too thin to score. It can also suggest skills
  your experience shows but never names. You approve each one, with no accept-all.
- **Tailor:** an AI rewrite whose safety rules are enforced in code, not only in the prompt. Dates,
  employers and links are kept, and dropped entries are restored. You can then edit every block
  by hand, add or remove whole entries, and see the score update live.
- **Export:** four ATS-safe templates (Classic, Technical, Formal, Modern), a live preview, and
  downloads as PDF or .txt or a copy to the clipboard.

**Tools**

- **Designer:** accent colour and font on top of any template, including fonts you import. An
  imported font is accepted only if text written in it reads back correctly from the PDF.
- **Match:** scores and ranks one resume against up to ten postings. Each posting costs one AI
  call on your key, and the page says so before you run it.
- **Cover Letter:** tone and length options, plus a check that flags any name or tool in the
  letter that your resume doesn't contain.

Your work is saved in your browser and restored on reload. **Start over** clears it and keeps
your API keys.

## Privacy

- **No backend.** No server, API routes, serverless functions or database.
- **No accounts.** No login, OAuth or cloud sync.
- **`localStorage` only.**
- **No telemetry.** No analytics, error reporting, web fonts or CDNs. The only network calls go to
  the AI provider you configure and, if you fetch a job posting by URL, a public CORS proxy.
- **Stored keys stay hidden.** The app never reads a stored key into the UI or renders it.
  Settings only knows whether each provider has one.

## AI providers

| Provider | Structured output |
| --- | --- |
| Claude | `output_config.format` |
| OpenAI | `json_schema`, strict |
| Google Gemini | `responseSchema` |
| Kimi | `json_schema`, strict |
| DeepSeek | `json_object` (schema folded into the prompt) |

Each provider has an ordered list of models. If a model is missing or overloaded, the call moves
to the next model from the same provider. Adding a provider means adding one registry entry in
`src/services/aiService.js`.

## Known limits

- **Fetching a job posting by URL.** Job boards don't allow direct browser requests, so the app
  tries a chain of public proxies. This works on Greenhouse, Lever and Ashby and fails on
  LinkedIn, Indeed and Glassdoor. Pasting the job description always works.
- **CJK PDFs.** pdf.js is kept fully local, so PDFs that use predefined CJK encodings extract as
  garbage.
- **Unsupported characters.** The built-in PDF fonts cover Windows-1252 only. Export names any
  character they cannot draw.

## Project layout

```
src/
  pages/          One component per route
  components/     Shell, UI primitives, the Tailor editor, PDF templates
  context/        The single useReducer + Context store
  services/       AI, parsing, scoring, tailoring, export, persistence (React-free)
    __manual__/   Console-run verification; not part of the build
  utils/          Skill synonyms, action verbs, fidelity and grounding checks, error text
```

## Verification

There is no test runner. Each service has a manual runner in `src/services/__manual__/`, which
you run from the browser console with the dev server up:

```js
const a = await import('/src/services/__manual__/analysis.manual.js');
a.testOffline();
```

`testOffline` and most other `test*` runners need no key and no network. `live*` runners change
whatever session is loaded, so run them on test data.

## License

MIT.
