import { Fragment, createContext, useContext, useMemo } from 'react';
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import {
  SECTION_TITLES,
  certificationHeading,
  contactParts,
  degreeLine,
  metaLine,
  roleHeading,
  skillLine,
} from '../../services/resumeExport.js';
import {
  Bullet,
  Bullets,
  FIELD_SEPARATOR,
  KeepTogether,
  UrlText,
  documentProps,
  leadFor,
  noHyphenation,
  presentSections,
} from './pdfParts.jsx';
import { resolveResumeTheme } from './resumeDesign.js';
import { templateById } from './resumeTemplates.js';

/**
 * The original resume template, "Classic" in the picker. Built to be read by
 * an ATS first and a person second -- and every other template in this folder
 * is held to the same list:
 *
 * - One column, top to bottom. No tables, no side panels, no icons: a parser
 *   reading a two-column layout interleaves the columns (the same failure
 *   pdfParser.js documents on the way in).
 * - Real text in the built-in Helvetica, never an image, so every word is
 *   selectable and extractable. Standard fonts need no font file, so nothing
 *   is fetched when the PDF is built.
 * - Section headings are plain words ("Experience", not "Where I've been").
 * - No hyphenation (noHyphenation, pdfParts.jsx). react-pdf's default split
 *   "quarterly" into "quar-" / "terly" and a LinkedIn url into two pieces at a
 *   line end; templates.manual.js caught both in this template.
 * - Headings are kept with what they head by grouping, not minPresenceAhead.
 *   See KeepTogether in pdfParts.jsx.
 *
 * Takes a resume already passed through normalizeResumeForExport, so every
 * field is a string or an array and nothing here needs guarding.
 */

const COLOR_TEXT = '#1a1a1a';
const COLOR_MUTED = '#555555';

/**
 * The template's styles for one theme (resumeDesign.js). Only font faces
 * and the accent colour vary; every size, spacing and margin is fixed here.
 */
function buildStyles({ faces, accent }) {
  return StyleSheet.create({
    page: {
      paddingVertical: 42,
      paddingHorizontal: 48,
      fontFamily: faces.regular,
      fontSize: 10,
      lineHeight: 1.35,
      color: COLOR_TEXT,
    },
    // The gap is load-bearing, not cosmetic. With a 3pt gap the 18pt name's line
    // box overlapped the contact line and pdf.js extracted "Jane Doejane@x.io"
    // as one run -- an ATS reading it the same way loses both the name and the
    // email. Verified by round-tripping the PDF through pdfParser.js.
    name: { fontFamily: faces.bold, fontSize: 18, lineHeight: 1.2, marginBottom: 8 },
    contact: { fontSize: 9.5, color: COLOR_MUTED },
    // Sections and entries are flat children of the Page, not wrapper Views --
    // see KeepTogether in pdfParts.jsx -- so their spacing lives on the title and
    // on each entry's group, as marginTop so nothing trails past the last line.
    sectionTitle: {
      marginTop: 13,
      fontFamily: faces.bold,
      fontSize: 10.5,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      paddingBottom: 2,
      marginBottom: 5,
      borderBottomWidth: 0.75,
      // Designer's accent lands here and only here: this template has no
    // other colour. The grey is the template's own look when none is chosen.
    borderBottomColor: accent ?? '#999999',
    },
    entry: { marginTop: 7 },
    entryHeading: { fontFamily: faces.bold, fontSize: 10.5 },
    meta: { fontSize: 9.5, color: COLOR_MUTED, marginBottom: 2 },
    bulletRow: { flexDirection: 'row', marginTop: 1.5 },
    bulletMark: { width: 10 },
    bulletText: { flex: 1 },
    link: { fontSize: 9.5, color: COLOR_MUTED, textDecoration: 'none' },
    skillRow: { marginBottom: 2 },
    skillCategory: { fontFamily: faces.bold },
  });
}

/** No theme passed = this template exactly as designed. */
const DEFAULT_THEME = resolveResumeTheme(templateById('classic').defaultFont);

// Subcomponents read the built styles from here rather than a module-level
// constant, because the styles now depend on the theme.
const StylesContext = createContext(buildStyles(DEFAULT_THEME));

const bulletPropsOf = (styles) => ({ rowStyle: styles.bulletRow, markStyle: styles.bulletMark, textStyle: styles.bulletText });

function EntryHeader({ heading, meta }) {
  const styles = useContext(StylesContext);
  return (
    <>
      {heading ? (
        <Text style={styles.entryHeading} hyphenationCallback={noHyphenation}>
          {heading}
        </Text>
      ) : null}
      {meta ? <Text style={styles.meta}>{meta}</Text> : null}
    </>
  );
}

function Links({ links }) {
  const styles = useContext(StylesContext);
  return links.map((link, i) => <UrlText key={i} url={link.url} style={styles.link} />);
}

/**
 * `lead` is the section title. It goes inside the first entry's KeepTogether
 * group, and each entry's header is grouped with its first bullet, so neither
 * a section heading nor a job title can be the last line on a page.
 */
function SectionBody({ resume, section, lead }) {
  const styles = useContext(StylesContext);
  const bulletProps = bulletPropsOf(styles);
  switch (section) {
    case 'summary':
      // Always directly under the contact header on page 1, so nothing to strand.
      return (
        <>
          {lead}
          <Text hyphenationCallback={noHyphenation}>{resume.summary}</Text>
        </>
      );

    case 'experience':
      return resume.experience.map((e, i) => (
        <Fragment key={i}>
          <KeepTogether style={i > 0 ? styles.entry : undefined}>
            {leadFor(lead, i)}
            <EntryHeader heading={roleHeading(e)} meta={metaLine(e)} />
            <Bullet item={e.bullets[0]} {...bulletProps} />
          </KeepTogether>
          <Bullets items={e.bullets.slice(1)} {...bulletProps} />
          <Links links={e.links} />
        </Fragment>
      ));

    case 'projects':
      return resume.projects.map((p, i) => (
        <Fragment key={i}>
          <KeepTogether style={i > 0 ? styles.entry : undefined}>
            {leadFor(lead, i)}
            <EntryHeader heading={p.name} meta="" />
            {p.description ? (
              <Text hyphenationCallback={noHyphenation}>{p.description}</Text>
            ) : (
              <Bullet item={p.bullets[0]} {...bulletProps} />
            )}
          </KeepTogether>
          <Bullets items={p.description ? p.bullets : p.bullets.slice(1)} {...bulletProps} />
          <Links links={p.links} />
        </Fragment>
      ));

    case 'skills':
      return resume.skills.map((group, i) => (
        <KeepTogether key={i}>
          {leadFor(lead, i)}
          <Text style={styles.skillRow} hyphenationCallback={noHyphenation}>
            {group.category ? <Text style={styles.skillCategory}>{`${group.category}: `}</Text> : null}
            {group.category ? group.skills.join(', ') : skillLine(group)}
          </Text>
        </KeepTogether>
      ));

    case 'education':
      return resume.education.map((ed, i) => (
        <Fragment key={i}>
          <KeepTogether style={i > 0 ? styles.entry : undefined}>
            {leadFor(lead, i)}
            <EntryHeader heading={[degreeLine(ed), ed.institution].filter(Boolean).join(' — ')} meta={metaLine(ed)} />
            <Bullet item={ed.details[0]} {...bulletProps} />
          </KeepTogether>
          <Bullets items={ed.details.slice(1)} {...bulletProps} />
        </Fragment>
      ));

    case 'certifications':
      return resume.certifications.map((c, i) => (
        <KeepTogether key={i} style={i > 0 ? styles.entry : undefined}>
          {leadFor(lead, i)}
          <Text hyphenationCallback={noHyphenation}>{certificationHeading(c)}</Text>
          {c.url ? <UrlText url={c.url} style={styles.link} /> : null}
        </KeepTogether>
      ));

    default:
      return null;
  }
}

/**
 * @param {{ resume: ReturnType<typeof import('../../services/resumeExport.js').normalizeResumeForExport> }} props
 */
export default function ResumeDocument({ resume, theme }) {
  const styles = useMemo(() => buildStyles(theme ?? DEFAULT_THEME), [theme]);
  const contact = contactParts(resume);

  return (
    <StylesContext.Provider value={styles}>
      <Document {...documentProps(resume)}>
        <Page size="A4" style={styles.page}>
          <View>
            {resume.name ? <Text style={styles.name}>{resume.name}</Text> : null}
            {contact.length > 0 ? (
              <Text style={styles.contact} hyphenationCallback={noHyphenation}>
                {contact.join(FIELD_SEPARATOR)}
              </Text>
            ) : null}
          </View>

          {presentSections(resume).map((section) => (
            <SectionBody
              key={section}
              resume={resume}
              section={section}
              lead={<Text style={styles.sectionTitle}>{SECTION_TITLES[section]}</Text>}
            />
          ))}
        </Page>
      </Document>
    </StylesContext.Provider>
  );
}
