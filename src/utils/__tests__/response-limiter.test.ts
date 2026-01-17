// eslint-disable-next-line import/no-extraneous-dependencies -- Test file, jest is a devDependency
import { describe, it, expect } from '@jest/globals';
import {
  estimateTokens,
  hashContent,
  truncateContent,
  limitSearchResults,
  limitResponse,
  DEFAULT_LIMITER_CONFIG
} from '../response-limiter';

describe('Response Limiter', () => {
  describe('estimateTokens', () => {
    it('should estimate tokens correctly', () => {
      expect(estimateTokens('test')).toBe(1);
      expect(estimateTokens('this is a test')).toBe(4);
      expect(estimateTokens('a'.repeat(100))).toBe(25);
    });
  });

  describe('hashContent', () => {
    it('should generate consistent hashes', () => {
      const content = 'test content';
      const hash1 = hashContent(content);
      const hash2 = hashContent(content);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(8);
    });

    it('should generate different hashes for different content', () => {
      const hash1 = hashContent('content 1');
      const hash2 = hashContent('content 2');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('truncateContent', () => {
    it('should not truncate short content', () => {
      const content = 'short text';
      expect(truncateContent(content, 20)).toBe(content);
    });

    it('should truncate long content', () => {
      const content = 'this is a very long text that needs to be truncated';
      const truncated = truncateContent(content, 20);
      expect(truncated).toBe('this is a very long...');
      expect(truncated.length).toBeLessThanOrEqual(23); // 20 + '...'
    });

    it('should truncate at word boundaries when possible', () => {
      const content = 'this is a test of word boundary truncation';
      const truncated = truncateContent(content, 15);
      expect(truncated).toBe('this is a test...');
    });
  });

  describe('limitSearchResults', () => {
    it('should process search results correctly', () => {
      const results = [
        {
          path: 'file1.md',
          title: 'File 1',
          content: 'This is the content of file 1 which is quite long and should be truncated',
          score: 0.9
        },
        {
          path: 'file2.md',
          title: 'File 2',
          content: 'Short content',
          score: 0.7
        }
      ];

      const limited = limitSearchResults(results);
      
      expect(limited.truncated).toBe(false);
      expect(limited.originalCount).toBe(2);
      expect(limited.results).toHaveLength(2);
      
      const result1 = limited.results[0] as any;
      expect(result1.path).toBe('file1.md');
      expect(result1.title).toBe('File 1');
      expect(result1.preview).toContain('This is the content');
      expect(result1.preview.length).toBeLessThanOrEqual(203); // 200 + '...'
      expect(result1.contentHash).toBeDefined();
      expect(result1.contentLength).toBe(73);
      expect(result1.score).toBe(0.9);
    });

    it('should truncate results when exceeding token limit', () => {
      const results = [];
      // Create many large results
      for (let i = 0; i < 1000; i++) {
        results.push({
          path: `file${i}.md`,
          title: `File ${i}`,
          content: 'x'.repeat(5000), // Very large content
          score: Math.random()
        });
      }

      const limited = limitSearchResults(results, { 
        ...DEFAULT_LIMITER_CONFIG, 
        maxTokens: 1000 
      });
      
      expect(limited.truncated).toBe(true);
      expect(limited.originalCount).toBe(1000);
      expect(limited.results.length).toBeLessThan(1000);
      
      // Verify all results have truncated content
      for (const result of limited.results as any[]) {
        expect(result.preview.length).toBeLessThanOrEqual(203);
      }
    });

    it('should handle missing content gracefully', () => {
      const results = [
        {
          path: 'file1.md',
          title: 'File 1'
          // No content
        },
        {
          path: 'file2.md',
          basename: 'file2', // Different property name
          context: 'Some context' // Different content property
        }
      ];

      const limited = limitSearchResults(results);
      
      expect(limited.results).toHaveLength(2);
      expect((limited.results[0] as any).preview).toBeUndefined();
      expect((limited.results[1] as any).title).toBe('file2');
      expect((limited.results[1] as any).preview).toBe('Some context');
    });
  });

  describe('limitResponse', () => {
    it('should not modify responses within token limit', () => {
      const response = { data: 'test', count: 5 };
      const limited = limitResponse(response);
      expect(limited).toEqual(response);
    });

    it('should limit large object responses', () => {
      const response: unknown = {
        error: 'test error',
        message: 'important message',
        data: 'x'.repeat(100000) // Very large data
      };

      const limited = limitResponse(response, {
        ...DEFAULT_LIMITER_CONFIG,
        maxTokens: 100
      }) as any;

      expect(limited.error).toBe('test error');
      expect(limited.message).toBe('important message');
      expect(limited.data).toBeUndefined(); // Should be excluded due to size
      expect(limited._truncated).toBe(true);
    });

    it('should limit large array responses', () => {
      const response = [];
      for (let i = 0; i < 1000; i++) {
        response.push({ id: i, data: 'x'.repeat(100) });
      }

      const limited = limitResponse(response, {
        ...DEFAULT_LIMITER_CONFIG,
        maxTokens: 500
      }) as any[];

      expect(Array.isArray(limited)).toBe(true);
      expect(limited.length).toBeLessThan(1000);
    });
  });
});