import { Link, Text, View } from '@react-pdf/renderer';

import { SECTION_ORDER, sectionHasContent } from '../../services/resumeExport.js';

/**
 * Pieces every resume template shares. Presentation only: each takes its
 * styles from the template calling it, and none of them reshapes data. What a
 * line SAYS comes from resumeExport.js's line builders; what it LOOKS like is
 * the template's business.
 */

/**
 * No hyphenation, in every template.
 *
 * react-pdf hyphenates long words at a line break by default, and pdf.js then
 * extracts them as two fragments -- "Kuber-" at the end of one line and
 * "netes" at the start of the next. A keyword split like that is not a keyword
 * to an ATS. Passed per <Text> rather than registered globally with
 * Font.registerHyphenationCallback, so importing a template has no side effect
 * on any other document.
 */
export const noHyphenation = (word) => [word];

/**
 * The separator between fields on one line. ONE space each side, not two: with
 * hyphenation off, react-pdf treats the empty "word" between two spaces as a
 * break point and draws a hyphen there, so a wrapped contact line read
 * "https://github.com/janedoe |-". Measured in isolation; do not widen it with
 * spaces -- use letter spacing or a style if it needs more air.
 */
export const FIELD_SEPARATOR = ' | ';

/**
 * KEEPING HEADINGS WITH WHAT THEY HEAD
 * A heading must never be the last line on a page. react-pdf's
 * `minPresenceAhead` looks like the tool for that and does not work here:
 * measured in isolation (react-pdf 4.x), a heading with minPresenceAhead={80}
 * followed by an unbreakable entry, a breakable entry, or a breakable entry
 * holding an unbreakable header was left as the page's last line every time
 * the gap was smaller than the entry. It first showed as "Certifications"
 * alone at the bottom of Modern's page 1, and the original template used the
 * same prop the same way.
 *
 * What does work is one unbreakable View around the heading and the start of
 * what it heads. So every template builds each section like this:
 * - the section title is passed down as `lead` and rendered inside the FIRST
 *   entry's KeepTogether group, never on its own;
 * - an entry's own header is grouped with its first bullet (or description),
 *   so a role title is never stranded above its bullets either.
 * The rest of each entry stays breakable, so a long role still flows across a
 * page instead of jumping whole. templates.manual.js's PAGES check asserts it.
 */
export function KeepTogether({ children, style }) {
  return (
    <View wrap={false} style={[{ flexShrink: 0 }, style]}>
      {children}
    </View>
  );
}

/** `lead` for the first item only. */
export const leadFor = (lead, index) => (index === 0 ? lead : null);

const isLinkable = (url) => /^(https?:\/\/|mailto:)/i.test(url);

export function UrlText({ url, style }) {
  return isLinkable(url) ? (
    <Link src={url} style={style}>
      {url}
    </Link>
  ) : (
    <Text style={style}>{url}</Text>
  );
}

/**
 * One row per bullet. The mark sits in its own fixed-width box so wrapped lines
 * hang under the text, not under the mark.
 */
export function Bullets({ items, rowStyle, markStyle, textStyle, mark = '•' }) {
  return items.map((item, i) => (
    <Bullet key={i} item={item} rowStyle={rowStyle} markStyle={markStyle} textStyle={textStyle} mark={mark} />
  ));
}

export function Bullet({ item, rowStyle, markStyle, textStyle, mark = '•' }) {
  if (!item) return null;
  return (
    <View style={rowStyle}>
      <Text style={markStyle}>{mark}</Text>
      <Text style={textStyle} hyphenationCallback={noHyphenation}>
        {item}
      </Text>
    </View>
  );
}

/** The sections this resume actually has, in the standard ATS order. */
export const presentSections = (resume) => SECTION_ORDER.filter((section) => sectionHasContent(resume, section));

/** PDF metadata. The same for every template, so a file's properties do not depend on its looks. */
export function documentProps(resume) {
  return {
    title: resume.name ? `${resume.name} - Resume` : 'Resume',
    author: resume.name || undefined,
    subject: 'Resume',
    creator: 'A2Resume',
    producer: 'A2Resume',
    language: 'en',
  };
}
