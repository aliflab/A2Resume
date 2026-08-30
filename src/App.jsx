import { NavLink, Outlet } from 'react-router';

const NAV = [
  { to: '/app', label: 'Workspace' },
  { to: '/analyze', label: 'Analyze' },
  { to: '/tailor', label: 'Tailor' },
  { to: '/match', label: 'Match' },
  { to: '/cover-letter', label: 'Cover Letter' },
  { to: '/designer', label: 'Designer' },
  { to: '/export', label: 'Export' },
  { to: '/settings', label: 'Settings' },
];

export default function App() {
  return (
    <div className="shell">
      <header className="shell__header">
        <NavLink to="/" className="shell__brand">
          A2Resume
        </NavLink>
        <nav className="shell__nav">
          {NAV.map(({ to, label }) => (
            <NavLink key={to} to={to}>
              {label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="shell__main">
        <Outlet />
      </main>

      <footer className="shell__footer">
        <span>Runs entirely in your browser. Your data never leaves this device.</span>
      </footer>
    </div>
  );
}
