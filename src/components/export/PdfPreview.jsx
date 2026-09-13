import { useMemo } from 'react';
import { PDFDownloadLink, PDFViewer } from '@react-pdf/renderer';

import ResumeDocument from './ResumeDocument.jsx';

/**
 * The only module that imports @react-pdf/renderer, and Export.jsx loads it
 * with React.lazy. Same reason pdfParser.js is imported dynamically: a static
 * import would put the PDF engine in the main bundle for every visitor,
 * including the ones who never reach step 4.
 *
 * The preview and the download are built from the same element. What the user
 * sees in the frame is what they get in the file.
 */
export default function PdfPreview({ resume, fileName }) {
  const doc = useMemo(() => <ResumeDocument resume={resume} />, [resume]);

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
        {document}
      </PDFViewer>
    </>
  );
}
