import { Link } from 'react-router';

import Icon from '../Icon.jsx';

/**
 * A described error (utils/errorMessages.js), laid out as "what happened" and
 * "what you can do". The message and hint are describeError's own words -- this
 * only adds a headline per kind of failure, so the explanation still lives in
 * one place and Settings, the pipeline and every page cannot drift apart.
 *
 * Never handed a raw Error: callers pass the result of describeError or
 * describeAiFailure, or a `{ message, isAuth }` they wrote themselves.
 */
const TITLES = {
  auth: 'Your API key was rejected',
  rate_limit: 'The provider is busy right now',
  no_model: 'No available model on this key',
  timeout: 'The provider took too long to answer',
  network: 'Couldn’t reach the provider',
  parse: 'The answer couldn’t be read',
  blocked: 'The provider declined this request',
  bad_request: 'The provider couldn’t accept the request',
  server: 'The provider had a problem',
};

function headline(error) {
  if (error.title) return error.title;
  if (error.kind === 'pdf') return 'We couldn’t read that PDF';
  if (error.kind === 'scrape') return 'We couldn’t read this job posting';
  if (error.isAuth) return TITLES.auth;
  return TITLES[error.code] ?? 'That didn’t finish';
}

export default function ErrorNotice({ error, onDismiss, onRetry, retryLabel = 'Try again', children, compact = false }) {
  if (!error) return null;
  return (
    <div className={`error-notice${compact ? ' error-notice--compact' : ''}`} role="alert">
      <span className="error-notice__icon">
        <Icon name="alert" size={18} />
      </span>
      <div className="error-notice__body">
        <p className="error-notice__title">{headline(error)}</p>
        {error.message && <p className="error-notice__message">{error.message}</p>}
        {error.hint && <p className="error-notice__hint">{error.hint}</p>}
        {(error.isAuth || onRetry || onDismiss || children) && (
          <div className="error-notice__actions">
            {error.isAuth && (
              <Link to="/settings" className="button button--sm">
                <Icon name="key" size={14} />
                Open Settings
              </Link>
            )}
            {children}
            {onRetry && (
              <button type="button" className="button button--sm" onClick={onRetry}>
                {retryLabel}
              </button>
            )}
            {onDismiss && (
              <button type="button" className="button button--sm button--ghost" onClick={onDismiss}>
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
