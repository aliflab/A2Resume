import { Link } from 'react-router';

import Icon from '../components/Icon.jsx';
import ScoreRing from '../components/ui/ScoreRing.jsx';
import { PROVIDER_LABELS, SUPPORTED_PROVIDERS } from '../services/aiService.js';

// Read from the registry, not retyped, so a provider added there appears here.
// aiService is already in the entry chunk (Input imports it), so this costs
// nothing extra to load.
const providerNames = SUPPORTED_PROVIDERS.map((id) => PROVIDER_LABELS[id]);
const providerList =
  providerNames.length <= 1
    ? providerNames.join('')
    : `${providerNames.slice(0, -1).join(', ')} or ${providerNames[providerNames.length - 1]}`;

// The same four steps, in the same order, as the header's step navigation.
const FLOW = [
  {
    to: '/input',
    icon: 'upload',
    title: 'Import',
    body: 'Upload your resume as a PDF or paste it in. The extracted text stays visible, so you can fix anything the PDF mangled.',
  },
  {
    to: '/analyze',
    icon: 'gauge',
    title: 'Analyze',
    body: 'Compare it against a real job description: a 100-point ATS score, the keywords you match, partly match and miss, and what to fix first.',
  },
  {
    to: '/tailor',
    icon: 'pencil',
    title: 'Tailor',
    body: 'Rewrite the relevant sections for this job, under rules against inventing numbers, employers or skills. Review every change and edit by hand.',
  },
  {
    to: '/export',
    icon: 'download',
    title: 'Export',
    body: 'Pick one of four ATS-friendly templates, set the colour and font, and download the PDF or copy plain text.',
  },
];

const TRUST = [
  {
    icon: 'noAccount',
    title: 'No account required',
    body: 'There is nothing to sign up to, because there is no server on the other end.',
  },
  {
    icon: 'database',
    title: 'Stored locally, in this browser',
    body: 'Your resume, job descriptions and every generated result are saved on this device only, until you press Start over.',
  },
  {
    icon: 'key',
    title: 'API keys stay in the browser',
    body: 'You bring a key from your own AI provider. It is kept in this browser and never displayed again after you save it.',
  },
  {
    icon: 'shield',
    title: 'Sent only to the provider you pick',
    body: `When you run an AI step, your resume goes straight from your browser to ${providerList} — whichever you choose — using your key. Charges appear on your own account.`,
  },
];

export default function Landing() {
  return (
    <div className="landing">
      <section className="landing__hero" aria-labelledby="landing-title">
        <div>
          <p className="eyebrow">AI-powered resume workspace</p>
          <h1 id="landing-title" className="landing__title">
            Build a resume that gets understood.
          </h1>
          <p className="landing__lede">
            Analyze your existing resume against a real job description, see exactly which skills and keywords are
            missing, tailor it for the role, and export a professional PDF that applicant tracking systems can read.
          </p>
          <div className="landing__actions">
            <Link to="/input" className="button button--primary button--lg">
              Start with your resume
              <Icon name="arrowRight" size={18} />
            </Link>
            <a href="#how-it-works" className="button button--lg">
              See how it works
            </a>
          </div>
          <ul className="landing__assurances">
            <li>
              <Icon name="check" size={16} />
              No account
            </li>
            <li>
              <Icon name="check" size={16} />
              Stored only in your browser
            </li>
            <li>
              <Icon name="check" size={16} />
              Your own AI key
            </li>
          </ul>
        </div>

        <div>
          <ProductPreview />
          <p className="preview-caption">Illustration of the Analyze step. Your numbers come from your own resume.</p>
        </div>
      </section>

      <section className="landing__section" id="how-it-works" aria-labelledby="landing-flow">
        <div className="landing__section-head">
          <h2 id="landing-flow" className="landing__heading">
            One calm workspace, four steps.
          </h2>
          <p className="landing__subhead">
            Each step builds on the last, and your progress is saved as you go, so a reload picks up where you left
            off. You can open any step at any time.
          </p>
        </div>
        <ol className="timeline">
          {FLOW.map(({ to, icon, title, body }, i) => (
            <li key={to} className="timeline__step">
              <div className="timeline__rail">
                <span className="timeline__index">{String(i + 1).padStart(2, '0')}</span>
              </div>
              <span className="timeline__icon">
                <Icon name={icon} size={20} />
              </span>
              <h3 className="timeline__title">
                <Link to={to}>
                  <span className="visually-hidden">Step {i + 1}: </span>
                  {title}
                </Link>
              </h3>
              <p className="timeline__body">{body}</p>
            </li>
          ))}
        </ol>
        <div className="landing__tools">
          <span className="landing__tools-label">Also included</span>
          <span className="landing__tool">
            <Icon name="target" size={16} />
            <span>
              <Link to="/match">Job Match</Link> ranks several postings against your resume
            </span>
          </span>
          <span className="landing__tool">
            <Icon name="mail" size={16} />
            <span>
              <Link to="/cover-letter">Cover Letter</Link> writes from what your resume actually says
            </span>
          </span>
          <span className="landing__tool">
            <Icon name="palette" size={16} />
            <span>
              <Link to="/designer">Designer</Link> sets your PDF&rsquo;s colour and font
            </span>
          </span>
        </div>
      </section>

      <section className="landing__section" aria-labelledby="landing-trust">
        <div className="landing__section-head">
          <h2 id="landing-trust" className="landing__heading">
            Your career data stays yours.
          </h2>
          <p className="landing__subhead">
            A2Resume has no backend, no database and no analytics. It only goes online when you ask it to: to the AI
            provider you configured, or, if you fetch a job posting by URL, to a public reader that loads that page.
          </p>
        </div>
        <div className="trust">
          <ul className="trust__list">
            {TRUST.map(({ icon, title, body }) => (
              <li key={title} className="trust__item">
                <span className="trust__icon">
                  <Icon name={icon} size={20} />
                </span>
                <div>
                  <h3 className="trust__title">{title}</h3>
                  <p className="trust__body">{body}</p>
                </div>
              </li>
            ))}
          </ul>
          <DataFlow />
        </div>
      </section>

      <section className="landing__cta" aria-labelledby="landing-cta">
        <div>
          <h2 id="landing-cta" className="landing__cta-title">
            Ready when you are.
          </h2>
          <p className="landing__cta-body">Have your resume and the job posting to hand. Step 1 takes both.</p>
        </div>
        <Link to="/input" className="button button--primary button--lg">
          Start with your resume
          <Icon name="arrowRight" size={18} />
        </Link>
      </section>
    </div>
  );
}

/**
 * A miniature of the Analyze workspace, built from the app's own styles (the
 * score ring, meters, keyword pills, the paper preview). Hidden from assistive
 * technology: it is a picture of a result, with illustrative numbers, and the
 * caption under it says so.
 */
function ProductPreview() {
  const rows = [
    { label: 'Keyword match', value: 84, tone: 'good' },
    { label: 'Placement', value: 100, tone: 'good' },
    { label: 'Bullet quality', value: 61, tone: 'mid' },
    { label: 'Skill breadth', value: 40, tone: 'poor' },
  ];
  return (
    <div className="preview-window" aria-hidden="true">
      <div className="preview-window__bar">
        <span className="preview-window__dots">
          <span />
          <span />
          <span />
        </span>
        <span className="preview-window__steps">
          <span className="is-done">
            <Icon name="check" size={11} />
            Input
          </span>
          <span className="is-current">Analyze</span>
          <span>Tailor</span>
          <span>Export</span>
        </span>
      </div>
      <div className="preview-window__body">
        <div className="preview-window__col">
          <div className="preview-card">
            <p className="preview-card__title">ATS score</p>
            <div className="preview-score">
              <ScoreRing percentage={81} size={64} />
              <div>
                <span className="preview-score__num">
                  81 <small>/ 100</small>
                </span>
                <span className="preview-score__verdict">Strong match</span>
              </div>
            </div>
          </div>
          <div className="preview-card">
            <p className="preview-card__title">Breakdown</p>
            <ul className="preview-rows">
              {rows.map(({ label, value, tone }) => (
                <li key={label}>
                  <span>{label}</span>
                  <span className="meter">
                    <span className={`meter__fill meter__fill--${tone}`} style={{ width: `${value}%`, display: 'block' }} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="preview-card">
            <p className="preview-card__title">Keyword coverage</p>
            <div className="pills">
              <span className="pill pill--success">Kubernetes</span>
              <span className="pill pill--success">PostgreSQL</span>
              <span className="pill pill--warning">gRPC</span>
              <span className="pill pill--danger">Kafka</span>
              <span className="pill pill--danger">Terraform</span>
            </div>
          </div>
        </div>
        <div className="preview-window__col preview-window__paper-col">
          <div className="preview-paper">
            <p className="preview-paper__name">Jordan Avery</p>
            <p className="preview-paper__contact">jordan@example.com · Remote</p>
            <p className="preview-paper__heading">Experience</p>
            <div className="preview-paper__line" style={{ width: '62%' }} />
            <div className="preview-paper__line preview-paper__line--hl" />
            <div className="preview-paper__line" style={{ width: '88%' }} />
            <div className="preview-paper__line preview-paper__line--hl" style={{ width: '74%' }} />
            <p className="preview-paper__heading">Skills</p>
            <div className="preview-paper__line" style={{ width: '80%' }} />
            <div className="preview-paper__line" style={{ width: '56%' }} />
          </div>
          <div className="preview-card">
            <p className="preview-card__title">Suggestions</p>
            <p className="preview-suggestion">
              <Icon name="arrowUp" size={12} />
              Mention Kafka where you describe event streaming.
            </p>
            <p className="preview-suggestion">
              <Icon name="arrowUp" size={12} />
              Add a metric to 2 bullets in your latest role.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Where data goes: a plain diagram of the only path out of the browser. */
function DataFlow() {
  return (
    <div className="trust__diagram">
      <p className="trust__diagram-title">Where your resume goes</p>
      <ol className="flowmap">
        <li className="flowmap__node flowmap__node--you">
          <Icon name="device" size={18} />
          <span>
            <strong>Your browser</strong>
            <span>Resume, results and keys stored here</span>
          </span>
        </li>
        <li className="flowmap__arrow">only when you run an AI step, with your key</li>
        <li className="flowmap__node">
          <Icon name="layers" size={18} />
          <span>
            <strong>The AI provider you chose</strong>
            <span>{providerList}</span>
          </span>
        </li>
      </ol>
      <p className="flowmap__none">
        <Icon name="x" size={14} />
        No A2Resume server, database, analytics or telemetry in between.
      </p>
    </div>
  );
}
