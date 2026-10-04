/**
 * A small rotating ring, coloured by the text around it, so it reads inside a
 * primary button and a neutral one alike.
 *
 * Decorative only (aria-hidden) and empty, so a button's textContent -- which
 * the manual runners match on -- is unchanged by adding one. The words next to
 * it always say what is happening; under prefers-reduced-motion the global rule
 * stops the rotation and the words still carry the meaning.
 */
export default function Spinner({ size = 'sm', className = '' }) {
  return <span className={`spinner spinner--${size} ${className}`.trim()} aria-hidden="true" />;
}
