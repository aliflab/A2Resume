import { Link } from 'react-router';

import Icon from '../Icon.jsx';

/**
 * A page with nothing to show yet. Every one answers the same three questions:
 * what is missing (title), why it matters (children), and what to do next
 * (the action). Pages render this instead of a blank screen when the store is
 * empty -- there are no route guards, so this is the normal cold-load state.
 */
export default function EmptyState({ icon = 'file', title, children, action, secondary, className = '' }) {
  return (
    <section className={`page empty-state ${className}`.trim()}>
      <div className="empty-state__art" aria-hidden="true">
        <span className="empty-state__sheet" />
        <span className="empty-state__sheet empty-state__sheet--back" />
        <span className="empty-state__icon">
          <Icon name={icon} size={22} />
        </span>
      </div>
      <h1 className="empty-state__title">{title}</h1>
      <div className="empty-state__body">{children}</div>
      {(action || secondary) && (
        <div className="empty-state__actions">
          {action && (
            <Link to={action.to} className="button button--primary">
              {action.label}
              <Icon name="arrowRight" size={16} />
            </Link>
          )}
          {secondary && (
            <Link to={secondary.to} className="button">
              {secondary.label}
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
