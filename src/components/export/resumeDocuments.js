import ResumeDocument from './ResumeDocument.jsx';
import TechnicalResumeDocument from './TechnicalResumeDocument.jsx';
import FormalResumeDocument from './FormalResumeDocument.jsx';
import ModernResumeDocument from './ModernResumeDocument.jsx';
import { RESUME_TEMPLATE_IDS, resolveResumeTemplate } from './resumeTemplates.js';

/**
 * Template id -> react-pdf component. Everything imported here pulls in
 * @react-pdf/renderer, so only modules already behind the lazy boundary may
 * import this file: PdfPreview.jsx, and the manual tests. The picker reads the
 * metadata in resumeTemplates.js instead.
 */
export const RESUME_DOCUMENTS = {
  classic: ResumeDocument,
  technical: TechnicalResumeDocument,
  formal: FormalResumeDocument,
  modern: ModernResumeDocument,
};

// The catalogue and this map are two lists of the same ids. Catch drift at load
// rather than as a picker option that silently renders the default.
const missing = RESUME_TEMPLATE_IDS.filter((id) => !RESUME_DOCUMENTS[id]);
if (missing.length > 0) console.warn('resumeDocuments: no component for template(s):', missing);

/** The component for a template id; anything unknown gets the default. */
export const resumeDocumentFor = (id) => RESUME_DOCUMENTS[resolveResumeTemplate(id)];
