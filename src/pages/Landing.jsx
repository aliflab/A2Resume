import { Link } from 'react-router';

export default function Landing() {
  return (
    <section className="page">
      <h1>A2Resume</h1>
      <p>
        A resume tool that runs entirely in your browser. No account, no server, no upload.
        Bring your own AI provider key when you want AI help.
      </p>
      <Link to="/app">Open the workspace</Link>
    </section>
  );
}
