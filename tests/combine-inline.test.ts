import { formatFileCombine, FileCombineResponse } from '../src/formatters/vault';

describe('formatFileCombine — inline (no destination) mode', () => {
  test('renders combined content inline without a Destination line', () => {
    const response: FileCombineResponse = {
      success: true,
      inline: true,
      content: 'alpha\n\n---\n\nbeta',
      filesCombined: 2,
      totalSize: 16,
      sourceFiles: ['a.md', 'b.md'],
    };

    const out = formatFileCombine(response);

    expect(out).toContain('Combined 2 files (inline)');
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
    // Inline mode wrote no file, so it must not claim a destination
    expect(out).not.toContain('Destination');
  });

  test('still renders destination mode when a destination is present', () => {
    const response: FileCombineResponse = {
      success: true,
      destination: 'combined.md',
      filesCombined: 2,
      totalSize: 16,
      sourceFiles: ['a.md', 'b.md'],
    };

    const out = formatFileCombine(response);

    expect(out).toContain('Combined: combined.md');
    expect(out).toContain('Destination');
    expect(out).not.toContain('(inline)');
  });

  test('inline branch requires content to be defined', () => {
    // inline:true but content undefined falls through to destination mode
    const response: FileCombineResponse = {
      success: true,
      inline: true,
      destination: 'fallback.md',
      filesCombined: 1,
    };

    const out = formatFileCombine(response);

    expect(out).toContain('Combined: fallback.md');
    expect(out).not.toContain('(inline)');
  });
});
