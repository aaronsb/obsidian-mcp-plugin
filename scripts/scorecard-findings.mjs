// Shared by scorecard.mjs (extraction) and scorecard-gate.mjs (comparison).
//
// The portal renders each finding as a JSX tuple whose React key is
// "<severity>:<index>:<text>" (e.g. "medium:0:**Direct Filesystem Access**: …"),
// and the scraper reads findings from that key (#315). Severity and position
// are rendering metadata, not finding text. Older scans keyed findings by the
// bare text, so the prefix is optional.
const FINDING_KEY_PREFIX = /^[a-z]+:\d+:/i;

export function stripFindingKey(finding) {
  return String(finding).trim().replace(FINDING_KEY_PREFIX, '');
}
