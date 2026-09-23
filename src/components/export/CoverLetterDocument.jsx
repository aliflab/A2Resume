import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

/**
 * The single cover letter template. One column, real text, built-in Helvetica
 * on A4 -- the same constraints `ResumeDocument` is built under and for the same
 * reasons, so the two documents in one application look like they came from the
 * same person.
 *
 * FONTS AND THE NO-NETWORK RULE
 * Standard PDF fonts need no font file, so building this fetches nothing. Never
 * `Font.register` a remote URL here, Google Fonts included -- `@react-pdf/font`
 * calls `fetch` for URL-registered fonts, which is the one way this page could
 * quietly break the BYOK contract. If a custom font is ever needed, bundle the
 * file and serve it same-origin, the way the pdf.js worker is served.
 *
 * The cost is that Helvetica covers only WinAnsi (Windows-1252). A character
 * outside it does not disappear, it comes out WRONG -- so the page names them
 * with `findUnsupportedPdfCharacters` rather than letting the letter be altered
 * silently.
 *
 * Takes a letter already through `normalizeCoverLetterForExport`, so every field
 * is a string or an array of them and nothing here needs guarding.
 */

const COLOR_TEXT = '#1a1a1a';
const COLOR_MUTED = '#555555';

const styles = StyleSheet.create({
  page: {
    paddingVertical: 56,
    paddingHorizontal: 64,
    fontFamily: 'Helvetica',
    fontSize: 11,
    // Looser than the resume's 1.35. A resume is scanned; a letter is read.
    lineHeight: 1.5,
    color: COLOR_TEXT,
  },
  // The same load-bearing gap as ResumeDocument's name style: with a tight gap
  // the larger name's line box overlaps the contact line and pdf.js extracts
  // them as one run ("Jane Doejane@x.io"). Do not tighten without re-running
  // the round trip in coverLetter.manual.js.
  name: { fontFamily: 'Helvetica-Bold', fontSize: 15, lineHeight: 1.2, marginBottom: 6 },
  contact: { fontSize: 9.5, color: COLOR_MUTED, lineHeight: 1.3 },
  head: { marginBottom: 26 },
  date: { fontSize: 10, color: COLOR_MUTED, marginBottom: 18 },
  addressee: { fontSize: 10.5, marginBottom: 20, lineHeight: 1.35 },
  greeting: { marginBottom: 12 },
  paragraph: { marginBottom: 11 },
  signoff: { marginTop: 10, lineHeight: 1.35 },
});

export default function CoverLetterDocument({ letter }) {
  return (
    <Document title={letter.name ? `${letter.name} - Cover Letter` : 'Cover Letter'}>
      <Page size="A4" style={styles.page}>
        {(letter.name || letter.contactLine) && (
          <View style={styles.head}>
            {letter.name ? <Text style={styles.name}>{letter.name}</Text> : null}
            {letter.contactLine ? <Text style={styles.contact}>{letter.contactLine}</Text> : null}
          </View>
        )}

        {letter.date ? <Text style={styles.date}>{letter.date}</Text> : null}

        {(letter.company || letter.jobTitle) && (
          <View style={styles.addressee}>
            {letter.company ? <Text>{letter.company}</Text> : null}
            {letter.jobTitle ? <Text>Re: {letter.jobTitle}</Text> : null}
          </View>
        )}

        {letter.greeting ? <Text style={styles.greeting}>{letter.greeting}</Text> : null}

        {letter.paragraphs.map((paragraph, i) => (
          // Index keys are correct here and nowhere else in this project: these
          // are immutable presentation strings rebuilt from the body on every
          // render, with no component state and no reordering to drift.
          // eslint-disable-next-line react/no-array-index-key
          <Text key={i} style={styles.paragraph}>
            {paragraph}
          </Text>
        ))}

        {letter.signoff ? <Text style={styles.signoff}>{letter.signoff}</Text> : null}
      </Page>
    </Document>
  );
}
