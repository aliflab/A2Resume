import { useMemo, useState } from 'react';
import { PDFDownloadLink, PDFViewer } from '@react-pdf/renderer';

import Icon from '../Icon.jsx';
import Spinner from '../ui/Spinner.jsx';
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
 * sees in the frame is what they get in the file. The frame sits on a canvas
 * and stays paper-white in both themes: it is the exported document.
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

  // Whether the frame is still showing an older document than `doc`. A
  // template, font or colour change builds a new document, and the frame
  // keeps the old page until the new one has loaded; until then the canvas is
  // dimmed with "Updating preview…". Cleared by the iframe's own load event,
  // which fires when the new PDF is actually on screen -- so this measures
  // what the user sees, and state is only ever set from that event handler.
  // The handler closes over this render's `doc`; React attaches the latest
  // render's handler, so a load always marks the newest document as shown.
  const [shownDoc, setShownDoc] = useState(null);
  const busy = shownDoc !== doc;

  return (
    <div className={`pdf-preview${busy ? ' pdf-preview--busy' : ''}`} aria-busy={busy || undefined}>
      <div className="pdf-preview__toolbar">
        <PDFDownloadLink document={doc} fileName={fileName} className="button button--primary">
          {({ loading, error }) => {
            if (error) return 'Could not build the PDF';
            // The text stays exactly "Preparing the PDF..." -- runners match it.
            return loading ? (
              <>
                <Spinner />
                Preparing the PDF...
              </>
            ) : (
              <>
                <Icon name="download" size={16} />
                Download PDF
              </>
            );
          }}
        </PDFDownloadLink>
        <span className="pdf-preview__file">
          <Icon name="file" size={14} />
          <span>{fileName}</span>
        </span>
      </div>

      <div className="pdf-canvas">
        <span className="pdf-canvas__busy" role="status">
          <Spinner />
          {shownDoc === null ? 'Rendering preview…' : 'Updating preview…'}
        </span>
        <PDFViewer className="export__preview" showToolbar onLoad={() => setShownDoc(doc)}>
          {doc}
        </PDFViewer>
      </div>
    </div>
  );
}
