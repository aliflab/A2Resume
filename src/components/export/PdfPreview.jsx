import { useMemo } from 'react';
import { PDFDownloadLink, PDFViewer } from '@react-pdf/renderer';

import { resumeDocumentFor } from './resumeDocuments.js';
import CoverLetterDocument from './CoverLetterDocument.jsx';
import { resolveResumeTheme } from './resumeDesign.js';
import { templateById } from './resumeTemplates.js';

/**
 * The only module that imports @react-pdf/renderer, and both Export.jsx and
 * CoverLetter.jsx load it with React.lazy. Same reason pdfParser.js is imported
 * dynamically: a static import would put the PDF engine in the main bundle for
 * every visitor, including the ones who never reach step 4.
 *
 * WHY THE TEMPLATE IS CHOSEN BY A STRING AND NOT PASSED IN
 * A caller passing `<CoverLetterDocument letter={...} />` would have to import
 * that component, and it imports @react-pdf/renderer -- which pulls the whole
 * engine back into the caller's chunk and undoes the lazy boundary this file
 * exists to create. `kind` keeps every react-pdf import on this side of it.
 * Adding a template means one entry in TEMPLATES, not a change to either page.
 * The resume kind has several layouts of its own, chosen by `template` (an id
 * from resumeTemplates.js) for the same reason: the id is a string, the
 * components stay on this side of the boundary.
 *
 * `accent` and `font` are Designer's choices (ids from resumeDesign.js, or
 * null for the template's own). They are resolved here against the template's
 * own default font, so a page never needs to know which family a template was
 * designed in.
 *
 * The preview and the download are built from the same element. What the user
 * sees in the frame is what they get in the file.
 */
const TEMPLATES = {
  resume: (data, template, accent, font) => {
    const ResumeLayout = resumeDocumentFor(template);
    const theme = resolveResumeTheme(templateById(template).defaultFont, { accent, font });
    return <ResumeLayout resume={data} theme={theme} />;
  },
  coverLetter: (data) => <CoverLetterDocument letter={data} />,
};

export default function PdfPreview({ kind = 'resume', data, resume, template, accent = null, font = null, fileName }) {
  // `resume` is the original prop name and Export.jsx still passes it.
  const payload = data ?? resume;
  const doc = useMemo(
    () => (TEMPLATES[kind] ?? TEMPLATES.resume)(payload, template, accent, font),
    [kind, payload, template, accent, font],
  );

  return (
    <>
      <p className="actions">
        <PDFDownloadLink document={doc} fileName={fileName} className="button button--primary">
          {({ loading, error }) => {
            if (error) return 'Could not build the PDF';
            return loading ? 'Preparing the PDF...' : 'Download PDF';
          }}
        </PDFDownloadLink>
        <span className="muted">{fileName}</span>
      </p>

      <PDFViewer className="export__preview" showToolbar>
        {doc}
      </PDFViewer>
    </>
  );
}
