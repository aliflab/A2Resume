import { Document, Link, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import {
  SECTION_ORDER,
  SECTION_TITLES,
  certificationHeading,
  contactParts,
  degreeLine,
  metaLine,
  roleHeading,
  sectionHasContent,
  skillLine,
} from '../../services/resumeExport.js';

/**
 * The single resume template. Built to be read by an ATS first and a person
 * second:
 *
 * - One column, top to bottom. No tables, no side panels, no icons: a parser
 *   reading a two-column layout interleaves the columns (the same failure
 *   pdfParser.js documents on the way in).
 * - Real text in the built-in Helvetica, never an image, so every word is
 *   selectable and extractable. Standard fonts need no font file, so nothing
 *   is fetched when the PDF is built.
 * - Section headings are plain words ("Experience", not "Where I've been").
 *
 * Takes a resume already passed through normalizeResumeForExport, so every
 * field is a string or an array and nothing here needs guarding.
 */

const COLOR_TEXT = '#1a1a1a';
const COLOR_MUTED = '#555555';

const styles = StyleSheet.create({
  page: {
    paddingVertical: 42,
    paddingHorizontal: 48,
    fontFamily: 'Helvetica',
    fontSize: 10,
    lineHeight: 1.35,
    color: COLOR_TEXT,
  },
  // The gap is load-bearing, not cosmetic. With a 3pt gap the 18pt name's line
  // box overlapped the contact line and pdf.js extracted "Jane Doejane@x.io"
  // as one run -- an ATS reading it the same way loses both the name and the
  // email. Verified by round-tripping the PDF through pdfParser.js.
  name: { fontFamily: 'Helvetica-Bold', fontSize: 18, lineHeight: 1.2, marginBottom: 8 },
  contact: { fontSize: 9.5, color: COLOR_MUTED },
  section: { marginTop: 13 },
  sectionTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10.5,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingBottom: 2,
    marginBottom: 5,
    borderBottomWidth: 0.75,
    borderBottomColor: '#999999',
  },
  entry: { marginBottom: 7 },
  entryHeading: { fontFamily: 'Helvetica-Bold', fontSize: 10.5 },
  meta: { fontSize: 9.5, color: COLOR_MUTED, marginBottom: 2 },
  bulletRow: { flexDirection: 'row', marginTop: 1.5 },
  bulletMark: { width: 10 },
  bulletText: { flex: 1 },
  link: { fontSize: 9.5, color: COLOR_MUTED, textDecoration: 'none' },
  skillRow: { marginBottom: 2 },
  skillCategory: { fontFamily: 'Helvetica-Bold' },
});

const isLinkable = (url) => /^(https?:\/\/|mailto:)/i.test(url);

function UrlText({ url }) {
  return isLinkable(url) ? (
    <Link src={url} style={styles.link}>
      {url}
    </Link>
  ) : (
    <Text style={styles.link}>{url}</Text>
  );
}

function Bullets({ items }) {
  return items.map((item, i) => (
    <View key={i} style={styles.bulletRow}>
      <Text style={styles.bulletMark}>•</Text>
      <Text style={styles.bulletText}>{item}</Text>
    </View>
  ));
}

function EntryHeader({ heading, meta }) {
  // Kept together, and kept with the first line after it, so a page break
  // never strands a job title at the bottom of a page.
  return (
    <View wrap={false} minPresenceAhead={24}>
      {heading ? <Text style={styles.entryHeading}>{heading}</Text> : null}
      {meta ? <Text style={styles.meta}>{meta}</Text> : null}
    </View>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} minPresenceAhead={36}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function SectionBody({ resume, section }) {
  switch (section) {
    case 'summary':
      return <Text>{resume.summary}</Text>;

    case 'experience':
      return resume.experience.map((e, i) => (
        <View key={i} style={styles.entry}>
          <EntryHeader heading={roleHeading(e)} meta={metaLine(e)} />
          <Bullets items={e.bullets} />
          {e.links.map((link, j) => (
            <UrlText key={j} url={link.url} />
          ))}
        </View>
      ));

    case 'projects':
      return resume.projects.map((p, i) => (
        <View key={i} style={styles.entry}>
          <EntryHeader heading={p.name} meta="" />
          {p.description ? <Text>{p.description}</Text> : null}
          <Bullets items={p.bullets} />
          {p.links.map((link, j) => (
            <UrlText key={j} url={link.url} />
          ))}
        </View>
      ));

    case 'skills':
      return resume.skills.map((group, i) => (
        <Text key={i} style={styles.skillRow}>
          {group.category ? <Text style={styles.skillCategory}>{`${group.category}: `}</Text> : null}
          {group.category ? group.skills.join(', ') : skillLine(group)}
        </Text>
      ));

    case 'education':
      return resume.education.map((ed, i) => (
        <View key={i} style={styles.entry}>
          <EntryHeader heading={[degreeLine(ed), ed.institution].filter(Boolean).join(' — ')} meta={metaLine(ed)} />
          <Bullets items={ed.details} />
        </View>
      ));

    case 'certifications':
      return resume.certifications.map((c, i) => (
        <View key={i} style={styles.entry} wrap={false}>
          <Text>{certificationHeading(c)}</Text>
          {c.url ? <UrlText url={c.url} /> : null}
        </View>
      ));

    default:
      return null;
  }
}

/**
 * @param {{ resume: ReturnType<typeof import('../../services/resumeExport.js').normalizeResumeForExport> }} props
 */
export default function ResumeDocument({ resume }) {
  const contact = contactParts(resume);

  return (
    <Document
      title={resume.name ? `${resume.name} - Resume` : 'Resume'}
      author={resume.name || undefined}
      subject="Resume"
      creator="A2Resume"
      producer="A2Resume"
      language="en"
    >
      <Page size="A4" style={styles.page}>
        <View>
          {resume.name ? <Text style={styles.name}>{resume.name}</Text> : null}
          {contact.length > 0 ? <Text style={styles.contact}>{contact.join('  |  ')}</Text> : null}
        </View>

        {SECTION_ORDER.filter((section) => sectionHasContent(resume, section)).map((section) => (
          <Section key={section} title={SECTION_TITLES[section]}>
            <SectionBody resume={resume} section={section} />
          </Section>
        ))}
      </Page>
    </Document>
  );
}
