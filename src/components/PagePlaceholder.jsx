export default function PagePlaceholder({ title, description }) {
  return (
    <section className="page">
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
  );
}
