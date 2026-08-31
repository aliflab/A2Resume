import { NavLink, Outlet } from 'react-router';

// The four wizard steps, then the side tools. Nothing here guards anything --
// every page must survive being opened directly with empty state.
const NAV = [
  { to: '/input', label: '1. Input' },
  { to: '/analyze', label: '2. Analyze' },
  { to: '/tailor', label: '3. Tailor' },
  { to: '/export', label: '4. Export' },
  { to: '/match', label: 'Match' },
  { to: '/cover-letter', label: 'Cover Letter' },
  { to: '/designer', label: 'Designer' },
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
