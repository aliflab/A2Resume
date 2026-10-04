/**
 * The top of every page: an eyebrow (where you are), the title, a lede (what
 * this page does), and optionally actions on the right. One component so every
 * page opens with the same rhythm.
 */
export default function PageHeader({ eyebrow, title, children, actions, className = '' }) {
  return (
    <header className={`page-header ${className}`.trim()}>
      <div className="page-header__text">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="page-header__title">{title}</h1>
        {children && <div className="page-header__lede">{children}</div>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}
