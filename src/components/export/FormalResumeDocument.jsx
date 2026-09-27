import { Fragment, createContext, useContext, useMemo } from 'react';
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import {
  SECTION_TITLES,
  certificationHeading,
  contactParts,
  degreeLine,
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
 * The formal template: Times, a centred letterhead, ruled section headings,
 * and the traditional executive entry -- organisation on the left with the
 * dates set flush right on the same line, the title in italics beneath.
 *
 * FONTS
 * Times-Roman / Times-Bold / Times-Italic are standard PDF fonts, like
 * Helvetica: no font file, nothing fetched. They cover the same WinAnsi set,
 * so findUnsupportedPdfCharacters and Export's warning apply unchanged.
 *
 * THE FLUSH-RIGHT DATES ARE THE ATS RISK IN THIS FILE, AND THE COST IS REAL
 * They are two boxes on one baseline, the layout most likely to weld fields
 * together: pdfParser.js joins fragments with no separator unless pdf.js
 * flags an end of line. Measured (templates.manual.js): pdf.js turns the
 * visual gap into a space, so the lines extract as
 *   "Acme Payments Mar 2021 – Present"
 *   "Senior Software Engineer Sydney, NSW"
 * -- no weld, every word intact, but the fields are separated by a SPACE, not
 * a delimiter. A parser has to decide where the title ends and the location
 * begins, which Classic's "Sydney, NSW | Mar 2021" never asks of it. And it
 * relies on the extractor's gap heuristic; pdf.js has one, not every ATS will.
 * An invisible (white) " | " between the boxes would make it explicit, and
 * was rejected: hidden text is itself a known ATS red flag (it is how keyword
 * stuffing is done). If this matters for a given application, Classic or
 * Technical carry the same content with explicit separators.
 *
 * Takes a resume already through normalizeResumeForExport.
 */

const COLOR_TEXT = '#1a1a1a';
const COLOR_MUTED = '#4a4a4a';

/**
 * The template's styles for one theme (resumeDesign.js). Only font faces
 * and the accent colour vary; every size, spacing and margin is fixed here.
 */
function buildStyles({ faces, accent }) {
  return StyleSheet.create({
    page: {
      paddingVertical: 50,
      paddingHorizontal: 58,
      fontFamily: faces.regular,
      fontSize: 10.5,
      lineHeight: 1.35,
      color: COLOR_TEXT,
    },
    header: { alignItems: 'center', marginBottom: 4 },
    // Same load-bearing gap as ResumeDocument's name, sized for the larger serif
    // name. Round-tripped in templates.manual.js; do not tighten without it.
    name: { fontFamily: faces.bold, fontSize: 20, lineHeight: 1.2, marginBottom: 8, textAlign: 'center' },
    contact: { fontSize: 9.5, color: COLOR_MUTED, textAlign: 'center' },
    // Sections and entries are flat children of the Page, not wrapper Views --
    // see KeepTogether in pdfParts.jsx -- so their spacing lives on the title and
    // on each entry's group, as marginTop so nothing trails past the last line.
    sectionTitle: {
      marginTop: 14,
      fontFamily: faces.bold,
      fontSize: 10.5,
      textTransform: 'uppercase',
      letterSpacing: 1,
      textAlign: 'center',
      paddingVertical: 2,
      marginBottom: 7,
      borderTopWidth: 0.75,
      borderBottomWidth: 0.75,
      // Designer's accent lands here and only here: this template has no
    // other colour. The grey is the template's own look when none is chosen.
    borderColor: accent ?? '#777777',
    },
    entry: { marginTop: 9 },
    line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    lineLeft: { flex: 1, paddingRight: 10 },
    lineRight: { textAlign: 'right' },
    org: { fontFamily: faces.bold, fontSize: 11 },
    role: { fontFamily: faces.italic },
    right: { color: COLOR_MUTED },
    bulletRow: { flexDirection: 'row', marginTop: 2 },
    bulletMark: { width: 12 },
    bulletText: { flex: 1 },
    link: { fontSize: 9.5, color: COLOR_MUTED, textDecoration: 'none' },
    skillRow: { marginBottom: 2.5 },
    skillCategory: { fontFamily: faces.bold },
  });
}

/** No theme passed = this template exactly as designed. */
const DEFAULT_THEME = resolveResumeTheme(templateById('formal').defaultFont);

// Subcomponents read the built styles from here rather than a module-level
// constant, because the styles now depend on the theme.
const StylesContext = createContext(buildStyles(DEFAULT_THEME));

/** Left text with an optional flush-right partner on the same line. */
function Line({ left, right, leftStyle }) {
  const styles = useContext(StylesContext);
  if (!left && !right) return null;
  return (
    <View style={styles.line}>
      <Text style={[styles.lineLeft, leftStyle]} hyphenationCallback={noHyphenation}>
        {left}
      </Text>
      {right ? <Text style={[styles.lineRight, styles.right]}>{right}</Text> : null}
    </View>
  );
}

/**
 * Two lines: organisation + dates, then role + location. When there is no
 * organisation the role moves up rather than leaving the top line empty.
 */
function EntryHeader({ org, role, dates, location }) {
  const styles = useContext(StylesContext);
  const top = org || role;
  const bottom = org ? role : '';
  return (
    <>
      <Line left={top} right={dates} leftStyle={styles.org} />
      <Line left={bottom} right={location} leftStyle={styles.role} />
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
      // Always directly under the letterhead on page 1, so nothing to strand.
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
            <EntryHeader org={e.company} role={e.title} dates={e.dates} location={e.location} />
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
            <EntryHeader org={p.name} role="" dates="" location="" />
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
            <EntryHeader org={ed.institution} role={degreeLine(ed)} dates={ed.dates} location={ed.location} />
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

export default function FormalResumeDocument({ resume, theme }) {
  const styles = useMemo(() => buildStyles(theme ?? DEFAULT_THEME), [theme]);
  const contact = contactParts(resume);

  return (
    <StylesContext.Provider value={styles}>
      <Document {...documentProps(resume)}>
        <Page size="A4" style={styles.page}>
          <View style={styles.header}>
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
