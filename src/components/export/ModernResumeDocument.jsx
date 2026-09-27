import { Fragment, createContext, useContext, useMemo } from 'react';
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import {
  SECTION_TITLES,
  certificationHeading,
  contactParts,
  educationHeading,
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
 * The modern template: airier spacing, a coloured accent on the name and the
 * section headings, and each entry led by its dates on a line of their own.
 *
 * WHY THE DATES ARE A LINE AND NOT A COLUMN
 * The familiar "modern" look puts dates in a narrow left gutter beside each
 * entry. That is a two-column row: the gutter and the entry are side-by-side
 * boxes, and pdf.js reads them in content-stream order, so a date that wraps
 * in the gutter interleaves with the entry's heading ("Jan 2021 –Senior
 * Engineer\nPresentAcme"). That is the multi-column failure pdfParser.js
 * documents on the way in, and every template here promises one column. So
 * the dates lead the entry, left-aligned, above it.
 *
 * Colour is only ever applied to text and rules, never to a background fill,
 * so the text stays dark-on-white where it matters for contrast and print.
 *
 * Takes a resume already through normalizeResumeForExport.
 */

const COLOR_TEXT = '#1d1d1f';
const COLOR_MUTED = '#5a5a5f';
const COLOR_ACCENT = '#1f5f7a';

/**
 * The template's styles for one theme (resumeDesign.js). Only font faces
 * and the accent colour vary; every size, spacing and margin is fixed here.
 */
function buildStyles({ faces, accent }) {
  // Designer's accent replaces this template's own colour everywhere it was
  // already used, and nowhere else.
  const tint = accent ?? COLOR_ACCENT;
  return StyleSheet.create({
    page: {
      paddingVertical: 46,
      paddingHorizontal: 54,
      fontFamily: faces.regular,
      fontSize: 10,
      lineHeight: 1.45,
      color: COLOR_TEXT,
    },
    // Same load-bearing gap as ResumeDocument's name, sized for the larger name.
    // Round-tripped in templates.manual.js; do not tighten without it.
    name: { fontFamily: faces.bold, fontSize: 22, lineHeight: 1.2, marginBottom: 9, color: tint },
    contact: { fontSize: 9.5, color: COLOR_MUTED },
    // Sections and entries are flat children of the Page, not wrapper Views --
    // see KeepTogether in pdfParts.jsx -- so their spacing lives on the title and
    // on each entry's group, as marginTop so nothing trails past the last line.
    sectionTitle: {
      marginTop: 18,
      fontFamily: faces.bold,
      fontSize: 11.5,
      color: tint,
      paddingLeft: 7,
      marginBottom: 8,
      borderLeftWidth: 2.5,
      borderLeftColor: tint,
    },
    entry: { marginTop: 11 },
    dates: { fontSize: 8.5, color: COLOR_MUTED, letterSpacing: 0.3 },
    heading: { fontFamily: faces.bold, fontSize: 10.5 },
    location: { fontSize: 9, color: COLOR_MUTED },
    bulletRow: { flexDirection: 'row', marginTop: 2.5 },
    bulletMark: { width: 11, color: tint },
    bulletText: { flex: 1 },
    link: { fontSize: 9, color: tint, textDecoration: 'none' },
    skillRow: { marginBottom: 3 },
    skillCategory: { fontFamily: faces.bold },
  });
}

/** No theme passed = this template exactly as designed. */
const DEFAULT_THEME = resolveResumeTheme(templateById('modern').defaultFont);

// Subcomponents read the built styles from here rather than a module-level
// constant, because the styles now depend on the theme.
const StylesContext = createContext(buildStyles(DEFAULT_THEME));

/** Dates, then the heading, then the location -- each its own line. */
function EntryHeader({ dates, heading, location }) {
  const styles = useContext(StylesContext);
  if (!dates && !heading && !location) return null;
  return (
    <>
      {dates ? <Text style={styles.dates}>{dates}</Text> : null}
      {heading ? (
        <Text style={styles.heading} hyphenationCallback={noHyphenation}>
          {heading}
        </Text>
      ) : null}
      {location ? <Text style={styles.location}>{location}</Text> : null}
    </>
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
            <EntryHeader dates={e.dates} heading={roleHeading(e)} location={e.location} />
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
            <EntryHeader dates="" heading={p.name} location="" />
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
            <EntryHeader dates={ed.dates} heading={educationHeading(ed)} location={ed.location} />
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

export default function ModernResumeDocument({ resume, theme }) {
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
