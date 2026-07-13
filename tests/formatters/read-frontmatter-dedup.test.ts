/**
 * vault.read must not print the frontmatter twice.
 *
 * A whole-note read returns the raw file, which already opens with the `---` frontmatter
 * block. The formatter additionally rendered a "## Frontmatter" summary above it — one
 * that truncates keys at 10 and values at 50 chars. So the most frequently called action
 * paid tokens to show a degraded copy of text it was about to show in full.
 */
import { formatFileRead } from '../../src/formatters/vault';

const FRONTMATTER = {
  title: 'The MRP-API hidden hub and its dependency cluster',
  section: '§7.3',
  part: 'Part IV — How We Move It'
};

const BODY_WITH_FRONTMATTER = [
  '---',
  'title: "The MRP-API hidden hub and its dependency cluster"',
  'section: "§7.3"',
  'part: "Part IV — How We Move It"',
  '---',
  '',
  '# 7.3 The MRP-API hidden hub',
  '',
  'It is the single point whose break cascades.'
].join('\n');

describe('formatFileRead frontmatter handling', () => {
  it('should not render a Frontmatter summary when the body already contains the block', () => {
    const output = formatFileRead({
      path: 'notes/7.3.md',
      content: BODY_WITH_FRONTMATTER,
      frontmatter: FRONTMATTER
    });

    expect(output).not.toContain('## Frontmatter');
  });

  it('should still return the body verbatim, frontmatter block included', () => {
    const output = formatFileRead({
      path: 'notes/7.3.md',
      content: BODY_WITH_FRONTMATTER,
      frontmatter: FRONTMATTER
    });

    expect(output).toContain('title: "The MRP-API hidden hub and its dependency cluster"');
    expect(output).toContain('It is the single point whose break cascades.');
  });

  it('should render a Frontmatter summary when the body does not carry the block', () => {
    // Fragment/window reads return a body without the raw frontmatter, so the summary is
    // the only place the caller can see it — keep it there.
    const output = formatFileRead({
      path: 'notes/7.3.md',
      content: '# 7.3 The MRP-API hidden hub\n\nIt is the single point whose break cascades.',
      frontmatter: FRONTMATTER
    });

    expect(output).toContain('## Frontmatter');
    expect(output).toContain('§7.3');
  });

  it('should still show the path for a note whose body carries frontmatter', () => {
    const output = formatFileRead({
      path: 'notes/7.3.md',
      content: BODY_WITH_FRONTMATTER,
      frontmatter: FRONTMATTER
    });

    expect(output).toContain('notes/7.3.md');
  });
});
