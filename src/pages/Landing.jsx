import { Link } from 'react-router';

import Icon from '../components/Icon.jsx';
import { PROVIDER_LABELS, SUPPORTED_PROVIDERS } from '../services/aiService.js';

// Read from the registry, not retyped, so a provider added there appears here.
// aiService is already in the entry chunk (Input imports it), so this costs
// nothing extra to load.
const providerNames = SUPPORTED_PROVIDERS.map((id) => PROVIDER_LABELS[id]);
const providerList =
  providerNames.length <= 1
    ? providerNames.join('')
    : `${providerNames.slice(0, -1).join(', ')} or ${providerNames[providerNames.length - 1]}`;

// The same four steps, in the same order and with the same names, as the
// header's step navigation. Each says what the step does, not what it is.
const FLOW = [
  {
    to: '/input',
    icon: 'upload',
    title: 'Input',
    body: 'Upload your resume as a PDF or paste it, then paste the job description or fetch it from the posting’s URL.',
  },
  {
    to: '/analyze',
    icon: 'chart',
    title: 'Analyze',
    body: 'Get a 100-point ATS score, the job’s keywords you match, partly match and miss, and what to fix first.',
  },
  {
    to: '/tailor',
    icon: 'pencil',
    title: 'Tailor',
    body: 'The AI rewrites your resume for this job, under rules against inventing numbers, employers or skills. Review every change and edit any part by hand.',
  },
  {
    to: '/export',
    icon: 'download',
    title: 'Export',
    body: 'Download an ATS-friendly PDF in one of four templates, or copy plain text for application forms.',
  },
];

const PRINCIPLES = [
  {
    icon: 'noAccount',
    title: 'No login',
    body: 'No accounts and no sign-up. There is nothing on the other end to sign up to.',
  },
  {
    icon: 'device',
    title: 'Stays in this browser',
    body: 'Your resume, the job and every result are saved only on this device, until you press Start over.',
  },
  {
    icon: 'key',
    title: 'Your own API key',
    body: 'Requests go straight from your browser to your provider, and the charges appear on your own account with that provider.',
  },
  {
    icon: 'layers',
    title: `${providerNames.length} AI providers`,
    body: `Use ${providerList}. Pick one each time you run an analysis.`,
  },
];

export default function Landing() {
  return (
    <div className="landing">
      <section className="landing__hero" aria-labelledby="landing-title">
        <div className="landing__intro">
          <p className="eyebrow">Resume tailoring that runs in your browser</p>
          <h1 id="landing-title" className="landing__title">
            Fit your resume to the job, with no account and no server in between.
          </h1>
          <p className="landing__lede">
            A2Resume scores your resume against a job description, shows which of the job&rsquo;s keywords
            you&rsquo;re missing, tailors it with the AI provider you choose, and exports a PDF an applicant
            tracking system can read.
          </p>
          <div className="landing__actions">
            <Link to="/input" className="button button--primary button--lg">
              Start with your resume
              <Icon name="arrowRight" size={18} />
            </Link>
            <Link to="/settings" className="button button--lg">
              Add an API key
            </Link>
          </div>
          <p className="landing__note">
            You&rsquo;ll need a key from one AI provider. It&rsquo;s saved only in this browser.
          </p>
        </div>

        <ScorePreview />
      </section>

      <section className="landing__section" aria-labelledby="landing-flow">
        <h2 id="landing-flow" className="landing__heading">
          Four steps, in order
        </h2>
        <p className="landing__subhead">
          Each step builds on the last. Your progress is saved as you go, so a reload picks up where you left off.
        </p>
        <ol className="flow">
          {FLOW.map(({ to, icon, title, body }, i) => (
            <li key={to} className="flow__step">
              <div className="flow__head">
                <span className="flow__num" aria-hidden="true">
                  {i + 1}
                </span>
                <Icon name={icon} size={20} className="flow__icon" />
              </div>
              <h3 className="flow__title">
                <Link to={to}>
                  <span className="visually-hidden">Step {i + 1}: </span>
                  {title}
                </Link>
              </h3>
              <p className="flow__body">{body}</p>
            </li>
          ))}
        </ol>
        <p className="landing__tools">
          Also included: <Link to="/match">Match</Link> ranks several postings against your resume,{' '}
          <Link to="/cover-letter">Cover Letter</Link> writes one from what your resume actually says, and{' '}
          <Link to="/designer">Designer</Link> sets the colour and font of your PDF.
        </p>
      </section>

      <section className="landing__section" aria-labelledby="landing-principles">
        <h2 id="landing-principles" className="landing__heading">
          Your data stays with you
        </h2>
        <p className="landing__subhead">
          Your resume is only ever sent to the AI provider you pick, using your own key. It never passes through a
          server belonging to this app, because there isn&rsquo;t one.
        </p>
        <ul className="principles">
          {PRINCIPLES.map(({ icon, title, body }) => (
            <li key={title} className="card card--surface principle">
              <span className="principle__icon">
                <Icon name={icon} size={20} />
              </span>
              <h3 className="principle__title">{title}</h3>
              <p className="principle__body">{body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing__cta card card--surface" aria-labelledby="landing-cta">
        <div>
          <h2 id="landing-cta" className="landing__cta-title">
            Ready when you are
          </h2>
          <p className="landing__cta-body">Have your resume and the job posting to hand. Step 1 takes both.</p>
        </div>
        <Link to="/input" className="button button--primary button--lg">
          Go to step 1
          <Icon name="arrowRight" size={18} />
        </Link>
      </section>
    </div>
  );
}

/**
 * An illustration of what step 2 produces, drawn from the same grade and
 * meter colours Analyze uses. Hidden from assistive technology: it is a
 * picture of a result, with made-up numbers, not a result.
 */
function ScorePreview() {
  const rows = [
    { label: 'Keyword match', value: 82, tone: 'good' },
    { label: 'Bullet quality', value: 64, tone: 'mid' },
    { label: 'Contact info', value: 100, tone: 'good' },
    { label: 'Skill breadth', value: 38, tone: 'poor' },
  ];
  return (
    <div className="preview card card--raised" aria-hidden="true">
      <div className="preview__head">
        <span className="preview__grade">B</span>
        <div>
          <p className="preview__total">
            78.4 <span>/ 100</span>
          </p>
          <p className="preview__caption">ATS score</p>
        </div>
      </div>
      <ul className="preview__rows">
        {rows.map(({ label, value, tone }) => (
          <li key={label}>
            <span className="preview__label">{label}</span>
            <span className={`preview__meter preview__meter--${tone}`}>
              <span style={{ width: `${value}%` }} />
            </span>
          </li>
        ))}
      </ul>
      <div className="preview__chips">
        <span className="pill pill--success">Kubernetes</span>
        <span className="pill pill--warning">gRPC</span>
        <span className="pill pill--danger">Kafka</span>
      </div>
    </div>
  );
}
