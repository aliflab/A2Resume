import { Fragment, createContext, useContext, useMemo } from 'react';
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import {
  SECTION_TITLES,
  certificationHeading,
  contactParts,
  educationHeading,
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
 * The dense template: smaller type, tighter margins and spacing, so a long
 * engineering history fits on fewer pages. Same one-column, real-text,
 * built-in-Helvetica rules as ResumeDocument (see the notes there).
 *
 * Where the density comes from, and why it is safe for an ATS: a heading and
 * its location/dates share ONE line, but as one <Text> with a literal " | "
 * inside it, never as two boxes placed side by side. pdfParser.js joins
 * fragments with no separator unless pdf.js flags an end of line, so two boxes
 * on one baseline are exactly how "Senior EngineerJan 2021" would be produced.
 * A separator that is part of the string cannot be lost.
 *
 * Takes a resume already through normalizeResumeForExport.
 */

const COLOR_TEXT = '#161616';
const COLOR_MUTED = '#505050';

/**
 * The template's styles for one theme (resumeDesign.js). Only font faces
 * and the accent colour vary; every size, spacing and margin is fixed here.
 */
function buildStyles({ faces, accent }) {
  return StyleSheet.create({
    page: {
      paddingVertical: 28,
      paddingHorizontal: 34,
      fontFamily: faces.regular,
      fontSize: 9,
      lineHeight: 1.25,
      color: COLOR_TEXT,
    },
    // Same load-bearing gap as ResumeDocument's name, scaled to the smaller
    // name. Round-tripped per template in templates.manual.js; do not tighten
    // without re-running it.
    name: { fontFamily: faces.bold, fontSize: 15, lineHeight: 1.2, marginBottom: 6 },
    contact: { fontSize: 8.5, color: COLOR_MUTED },
    // Sections and entries are flat children of the Page, not wrapper Views --
    // see KeepTogether in pdfParts.jsx -- so their spacing lives on the title and
    // on each entry's group, as marginTop so nothing trails past the last line.
    sectionTitle: {
      marginTop: 8,
      fontFamily: faces.bold,
      fontSize: 9,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      paddingBottom: 1.5,
      marginBottom: 3,
      borderBottomWidth: 0.5,
      // Designer's accent lands here and only here: this template has no
    // other colour. The grey is the template's own look when none is chosen.
    borderBottomColor: accent ?? '#888888',
    },
    entry: { marginTop: 4.5 },
    heading: { fontFamily: faces.bold },
    headingMeta: { fontFamily: faces.regular, color: COLOR_MUTED },
    bulletRow: { flexDirection: 'row', marginTop: 0.75 },
    bulletMark: { width: 8 },
    bulletText: { flex: 1 },
    link: { fontSize: 8.5, color: COLOR_MUTED, textDecoration: 'none' },
    skillRow: { marginBottom: 1 },
    skillCategory: { fontFamily: faces.bold },
  });
}

/** No theme passed = this template exactly as designed. */
const DEFAULT_THEME = resolveResumeTheme(templateById('technical').defaultFont);

// Subcomponents read the built styles from here rather than a module-level
// constant, because the styles now depend on the theme.
const StylesContext = createContext(buildStyles(DEFAULT_THEME));

/** "Heading | meta" as one run of text. See the note at the top of the file. */
function InlineHeading({ heading, meta }) {
  const styles = useContext(StylesContext);
  if (!heading && !meta) return null;
  return (
    <Text hyphenationCallback={noHyphenation}>
      {heading ? <Text style={styles.heading}>{heading}</Text> : null}
      {heading && meta ? <Text style={styles.headingMeta}>{FIELD_SEPARATOR}</Text> : null}
      {meta ? <Text style={styles.headingMeta}>{meta}</Text> : null}
    </Text>
  );
}

function Links({ links }) {
  const styles = useContext(StylesContext);
  return links.map((link, i) => (
    <UrlText key={i} url={link.url} style={styles.link} />
  ));
}

const bulletPropsOf = (styles) => ({ rowStyle: styles.bulletRow, markStyle: styles.bulletMark, textStyle: styles.bulletText });

/**
 * `lead` is the section title. It goes inside the first entry's KeepTogether
 * group, and each entry's header is grouped with its first bullet -- see
 * KeepTogether in pdfParts.jsx for why minPresenceAhead is not used.
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
            <InlineHeading heading={roleHeading(e)} meta={metaLine(e)} />
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
            <InlineHeading heading={p.name} meta="" />
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
            <InlineHeading heading={educationHeading(ed)} meta={metaLine(ed)} />
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

export default function TechnicalResumeDocument({ resume, theme }) {
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
