import Icon from '../Icon.jsx';
import { RESUME_TEMPLATES } from './resumeTemplates.js';

/**
 * The template choice, as a radio group: one tab stop with arrow-key selection
 * for free. Used by Export and Designer, which both write the same setting
 * (`settings.resumeTemplate`).
 *
 * Each option carries a schematic thumbnail drawn in CSS -- a sketch of the
 * layout, not a render. Rendering four PDFs to show one would cost seconds;
 * the live preview beside the picker already shows the real thing.
 *
 * Imports no react-pdf, so it is safe outside the lazy PDF chunk.
 * `accentHex` tints the sketch where that template would use the accent.
 */
export default function TemplatePicker({ value, onChange, accentHex = null, note = true }) {
  return (
    <fieldset className="template-picker">
      <legend className="field-label">Template</legend>
      {note && (
        <p className="muted template-picker__note">
          Every template is one column with standard headings and real, selectable text, so an ATS reads them all the
          same way. Only the look changes.
        </p>
      )}
      <div className="template-picker__options">
        {RESUME_TEMPLATES.map((t) => (
          <label key={t.id} className={`template-option${t.id === value ? ' template-option--selected' : ''}`}>
            <input type="radio" name="resume-template" value={t.id} checked={t.id === value} onChange={() => onChange(t.id)} />
            <TemplateThumb id={t.id} accentHex={accentHex} />
            <span className="template-option__label">
              {t.label}
              {t.id === value && <Icon name="checkCircle" size={16} />}
            </span>
            <span className="template-option__description">{t.description}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TemplateThumb({ id, accentHex }) {
  const style = accentHex ? { '--thumb-accent': accentHex } : undefined;
  const body = (
    <>
      <i />
      <i className="t-short" />
      <i />
    </>
  );
  return (
    <span className={`tpl-thumb tpl-thumb--${id}`} style={style} aria-hidden="true">
      <i className="t-name" />
      <i className="t-meta" />
      <i className="t-head" />
      <i className="t-rule" />
      {body}
      <i className="t-head" />
      <i className="t-rule" />
      {body}
    </span>
  );
}
