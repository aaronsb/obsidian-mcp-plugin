import {
  InputValidator,
  FileSizeValidator,
  PathSafetyValidator,
  SafeRegexValidator,
  BatchLimitValidator,
  ValidationException,
  DEFAULT_VALIDATION_CONFIG
} from '../../src/validation/input-validator';

describe('InputValidator', () => {
  let validator: InputValidator;

  beforeEach(() => {
    validator = new InputValidator();
  });

  describe('File Creation Validation', () => {
    it('should accept valid file creation params', () => {
      const result = validator.validate('file.create', {
        path: 'notes/test.md',
        content: 'Hello world'
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject file with size exceeding limit', () => {
      const largeContent = 'a'.repeat(11 * 1024 * 1024); // 11MB
      const result = validator.validate('file.create', {
        path: 'notes/test.md',
        content: largeContent
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors![0].code).toBe('FILE_SIZE_EXCEEDED');
    });

    it('should reject path with traversal attempt', () => {
      const result = validator.validate('file.create', {
        path: '../../../etc/passwd',
        content: 'malicious'
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(e => e.code === 'PATH_TRAVERSAL')).toBe(true);
    });

    it('should reject absolute paths', () => {
      const result = validator.validate('file.create', {
        path: '/etc/passwd',
        content: 'test'
      });

      expect(result.valid).toBe(false);
      expect(result.errors!.some(e => e.code === 'ABSOLUTE_PATH')).toBe(true);
    });
  });

  describe('File Update Validation', () => {
    it('should accept valid file update', () => {
      const result = validator.validate('file.update', {
        path: 'notes/existing.md',
        content: 'Updated content'
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('Search Query Validation', () => {
    it('should accept simple search query', () => {
      const result = validator.validate('search.query', {
        query: 'simple search'
      });

      expect(result.valid).toBe(true);
    });

    it('should accept valid regex', () => {
      const result = validator.validate('search.query', {
        query: 'test.*pattern'
      });

      expect(result.valid).toBe(true);
    });

    it('should reject ReDoS vulnerable regex', () => {
      const result = validator.validate('search.query', {
        query: '(a+)+'
      });

      expect(result.valid).toBe(false);
      expect(result.errors!.some(e => e.code === 'REGEX_TOO_COMPLEX')).toBe(true);
    });

    it('should reject excessively long query', () => {
      const longQuery = 'a'.repeat(1001);
      const result = validator.validate('search.query', {
        query: longQuery
      });

      expect(result.valid).toBe(false);
      expect(result.errors!.some(e => e.code === 'QUERY_TOO_LONG')).toBe(true);
    });
  });

  describe('Batch Operation Validation', () => {
    it('should accept valid batch combine', () => {
      const result = validator.validate('batch.combine', {
        paths: ['file1.md', 'file2.md', 'file3.md'],
        path: 'output.md'
      });

      expect(result.valid).toBe(true);
    });

    it('should reject batch exceeding size limit', () => {
      const largeBatch = Array(101).fill('file.md');
      const result = validator.validate('batch.combine', {
        paths: largeBatch,
        path: 'output.md'
      });

      expect(result.valid).toBe(false);
      expect(result.errors!.some(e => e.code === 'BATCH_SIZE_EXCEEDED')).toBe(true);
    });
  });
});

describe('FileSizeValidator', () => {
  let validator: FileSizeValidator;

  beforeEach(() => {
    validator = new FileSizeValidator(DEFAULT_VALIDATION_CONFIG);
  });

  it('should accept content within size limit', () => {
    const result = validator.validate({
      content: 'Normal sized content'
    });

    expect(result.valid).toBe(true);
  });

  it('should reject content exceeding size limit', () => {
    const largeContent = 'a'.repeat(11 * 1024 * 1024);
    const result = validator.validate({
      content: largeContent
    });

    expect(result.valid).toBe(false);
    expect(result.errors![0].code).toBe('FILE_SIZE_EXCEEDED');
    expect(result.errors![0].message).toContain('MB');
  });

  it('should handle undefined content', () => {
    const result = validator.validate({});

    expect(result.valid).toBe(true);
  });
});

describe('PathSafetyValidator', () => {
  let validator: PathSafetyValidator;

  beforeEach(() => {
    validator = new PathSafetyValidator(DEFAULT_VALIDATION_CONFIG);
  });

  it('should accept valid relative path', () => {
    const result = validator.validate({
      path: 'folder/subfolder/file.md'
    });

    expect(result.valid).toBe(true);
  });

  it('should reject path traversal', () => {
    const result = validator.validate({
      path: '../../etc/passwd'
    });

    expect(result.valid).toBe(false);
    expect(result.errors!.some(e => e.code === 'PATH_TRAVERSAL')).toBe(true);
  });

  it('should reject absolute Unix paths', () => {
    const result = validator.validate({
      path: '/etc/passwd'
    });

    expect(result.valid).toBe(false);
    expect(result.errors!.some(e => e.code === 'ABSOLUTE_PATH')).toBe(true);
  });

  it('should reject absolute Windows paths', () => {
    const result = validator.validate({
      path: 'C:\\Windows\\System32'
    });

    expect(result.valid).toBe(false);
    expect(result.errors!.some(e => e.code === 'ABSOLUTE_PATH')).toBe(true);
  });

  it('should reject path with null bytes', () => {
    const result = validator.validate({
      path: 'file\x00.md'
    });

    expect(result.valid).toBe(false);
    expect(result.errors!.some(e => e.code === 'NULL_BYTE_IN_PATH')).toBe(true);
  });

  it('should reject path exceeding length limit', () => {
    const longPath = 'a'.repeat(256) + '.md';
    const result = validator.validate({
      path: longPath
    });

    expect(result.valid).toBe(false);
    expect(result.errors!.some(e => e.code === 'PATH_TOO_LONG')).toBe(true);
  });

  it('should reject path with invalid characters', () => {
    const result = validator.validate({
      path: 'file<>:"|?*.md'
    });

    expect(result.valid).toBe(false);
    expect(result.errors!.some(e => e.code === 'INVALID_CHARACTERS')).toBe(true);
  });
});

describe('SafeRegexValidator', () => {
  let validator: SafeRegexValidator;

  beforeEach(() => {
    validator = new SafeRegexValidator(DEFAULT_VALIDATION_CONFIG);
  });

  it('should accept simple text query', () => {
    const result = validator.validate({
      query: 'simple text'
    });

    expect(result.valid).toBe(true);
  });

  it('should accept safe regex patterns', () => {
    const result = validator.validate({
      query: 'test.*pattern'
    });

    expect(result.valid).toBe(true);
  });

  it('should reject nested quantifiers', () => {
    const result = validator.validate({
      query: '(a+)+'
    });

    expect(result.valid).toBe(false);
    expect(result.errors![0].code).toBe('REGEX_TOO_COMPLEX');
  });

  it('should reject nested star quantifiers', () => {
    const result = validator.validate({
      query: '(a*)*'
    });

    expect(result.valid).toBe(false);
    expect(result.errors![0].code).toBe('REGEX_TOO_COMPLEX');
  });

  it('should reject invalid regex syntax', () => {
    const result = validator.validate({
      query: '([unclosed'
    });

    expect(result.valid).toBe(false);
    expect(result.errors![0].code).toBe('INVALID_REGEX');
  });

  it('should calculate complexity correctly', () => {
    // Very complex regex with many quantifiers and groups
    const complexRegex = '((a+)|(b*)){1,10}.*\\1.*';
    const result = validator.validate({
      query: complexRegex
    });

    // This should exceed the complexity limit
    expect(result.valid).toBe(false);
  });
});

describe('BatchLimitValidator', () => {
  let validator: BatchLimitValidator;

  beforeEach(() => {
    validator = new BatchLimitValidator(DEFAULT_VALIDATION_CONFIG);
  });

  it('should accept batch within limit', () => {
    const result = validator.validate({
      paths: Array(50).fill('file.md')
    });

    expect(result.valid).toBe(true);
  });

  it('should reject batch exceeding limit', () => {
    const result = validator.validate({
      paths: Array(101).fill('file.md')
    });

    expect(result.valid).toBe(false);
    expect(result.errors![0].code).toBe('BATCH_SIZE_EXCEEDED');
  });

  it('should handle undefined paths', () => {
    const result = validator.validate({});

    expect(result.valid).toBe(true);
  });

  it('should validate maxFiles parameter', () => {
    const result = validator.validate({
      maxFiles: 150
    });

    expect(result.valid).toBe(false);
    expect(result.errors![0].code).toBe('MAX_FILES_EXCEEDED');
  });
});

describe('ValidationException', () => {
  it('should create exception with errors', () => {
    const errors = [
      {
        field: 'content',
        message: 'File too large',
        code: 'FILE_SIZE_EXCEEDED'
      }
    ];

    const exception = new ValidationException(errors);

    expect(exception.errors).toEqual(errors);
    expect(exception.message).toBe('Validation failed');
    expect(exception.name).toBe('ValidationException');
  });

  it('should create exception with custom message', () => {
    const exception = new ValidationException([], 'Custom error');

    expect(exception.message).toBe('Custom error');
  });
});

describe('Configuration Updates', () => {
  let validator: InputValidator;

  beforeEach(() => {
    validator = new InputValidator();
  });

  it('should allow config updates', () => {
    validator.updateConfig({
      maxFileSize: 1024 * 1024 // 1MB
    });

    const config = validator.getConfig();
    expect(config.maxFileSize).toBe(1024 * 1024);
  });

  it('should re-initialize validators after config update', () => {
    validator.updateConfig({
      maxBatchSize: 10
    });

    const result = validator.validate('batch.combine', {
      paths: Array(15).fill('file.md'),
      path: 'output.md'
    });

    expect(result.valid).toBe(false);
    expect(result.errors![0].code).toBe('BATCH_SIZE_EXCEEDED');
  });
});
