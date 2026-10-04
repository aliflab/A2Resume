import { PROXY_IDS } from '../../services/jdScraper.js';
import WorkingLine from './WorkingLine.jsx';

/**
 * Where a job-posting URL fetch has got to, on Input and Match.
 *
 * The scraper tries several public readers in turn (jdScraper.js) and reports
 * each finished attempt through `onAttempt`; the page collects them into
 * `attempts`. So the line can say which reader is being tried and what the last
 * one did, instead of sitting on "Fetching..." for up to 45 seconds.
 */
export default function FetchProgress({ attempts = [] }) {
  const tried = attempts.length;
  const last = attempts[tried - 1];
  const total = PROXY_IDS.length;
  return (
    <WorkingLine
      label={`Trying reader ${Math.min(tried + 1, total)} of ${total}…`}
      detail={
        last
          ? `${last.label} ${last.ok ? 'answered; checking it is the posting' : 'did not work'}.`
          : 'Trying the posting directly first.'
      }
    />
  );
}
