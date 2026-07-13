/**
 * The footer must not imply that content was abbreviated.
 *
 * Measured failure: every response ended with "_Summary view. For all metadata fields,
 * use `raw: true`._". On tools whose whole job is faithful retrieval, "Summary view"
 * reads as a truncation warning, and callers spent real attention deciding whether the
 * note body they had been handed was a lossy rendering of the argument.
 *
 * Only metadata is abbreviated. Genuine content truncation is announced in its own right
 * (a Pagination section, or an explicit "... and N more" line), so the footer should name
 * what it actually elides rather than leaving the reader to guess it might be the text.
 */
import { summaryFooter } from '../../src/formatters/utils';
import { formatFileRead } from '../../src/formatters/vault';

describe('summaryFooter', () => {
  it('should not describe the response as a summary of the content', () => {
    expect(summaryFooter()).not.toMatch(/summary view/i);
  });

  it('should name metadata as the thing that is abbreviated', () => {
    expect(summaryFooter()).toMatch(/metadata/i);
  });

  it('should still point at raw for the full payload', () => {
    expect(summaryFooter()).toContain('raw: true');
  });
});

describe('formatFileRead — completeness signalling', () => {
  const BODY = '# 7.3 The MRP-API hidden hub\n\nIt is the single point whose break cascades.';

  it('should not suggest the body was summarized on a whole-note read', () => {
    const output = formatFileRead({ path: 'notes/7.3.md', content: BODY });

    expect(output).not.toMatch(/summary view/i);
    expect(output).toContain('It is the single point whose break cascades.');
  });

  it('should announce truncation explicitly when the read is paginated', () => {
    const output = formatFileRead({
      path: 'notes/big.md',
      content: BODY,
      pagination: {
        paginated: true,
        page: 1,
        pageLineStart: 1,
        pageLineEnd: 100,
        totalLines: 400,
        bytes: 4000,
        hasMore: true,
        nextPage: '2'
      }
    });

    // A caller must be able to tell a paginated read from a complete one without
    // inferring it from the presence of a trailing footnote block.
    expect(output).toMatch(/pagination/i);
  });
});
