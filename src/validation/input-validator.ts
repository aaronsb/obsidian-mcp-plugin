/**
 * Input Validation Framework
 *
 * Provides comprehensive input validation for all MCP operations to prevent:
 * - Memory exhaustion (file size limits)
 * - ReDoS attacks (regex validation)
 * - DoS attacks (batch operation limits)
 * - Path traversal (path safety checks)
 * - Data corruption (content validation)
 */

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
  value?: any;
}

export interface Validator {
  validate(value: any, context?: any): ValidationResult;
}

export interface ValidationConfig {
  maxFileSize: number;        // Maximum file size in bytes (default: 10MB)
  maxBatchSize: number;        // Maximum number of items in batch operations (default: 100)
  maxPathLength: number;       // Maximum path length (default: 255)
  maxRegexComplexity: number;  // Maximum regex complexity score (default: 100)
  strictMode: boolean;         // Enable strict validation (default: false)
  allowedFileTypes?: string[]; // Allowed file extensions (undefined = all)
}

export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxBatchSize: 100,
  maxPathLength: 255,
  maxRegexComplexity: 100,
  strictMode: false,
  allowedFileTypes: undefined // Allow all by default
};

/**
 * Main input validator class
 */
export class InputValidator {
  private config: ValidationConfig;
  private validators: Map<string, Validator[]>;

  constructor(config: Partial<ValidationConfig> = {}) {
    this.config = { ...DEFAULT_VALIDATION_CONFIG, ...config };
    this.validators = new Map();
    this.initializeValidators();
  }

  /**
   * Initialize validators for different operation types
   */
  private initializeValidators(): void {
    // File creation validators
    this.validators.set('file.create', [
      new PathSafetyValidator(this.config),
      new FileSizeValidator(this.config),
      new ContentValidator(this.config)
    ]);

    // File update validators
    this.validators.set('file.update', [
      new PathSafetyValidator(this.config),
      new FileSizeValidator(this.config),
      new ContentValidator(this.config)
    ]);

    // File append validators
    this.validators.set('file.append', [
      new FileSizeValidator(this.config),
      new ContentValidator(this.config)
    ]);

    // Search validators
    this.validators.set('search.query', [
      new SafeRegexValidator(this.config),
      new QueryLengthValidator(this.config)
    ]);

    // Batch operation validators
    this.validators.set('batch.combine', [
      new BatchLimitValidator(this.config),
      new PathArrayValidator(this.config)
    ]);

    this.validators.set('batch.split', [
      new BatchLimitValidator(this.config)
    ]);
  }

  /**
   * Validate input for a specific operation
   */
  validate(operation: string, params: Record<string, any>): ValidationResult {
    const validators = this.validators.get(operation);

    if (!validators || validators.length === 0) {
      // No validators defined for this operation
      return { valid: true };
    }

    const errors: ValidationError[] = [];

    for (const validator of validators) {
      const result = validator.validate(params, this.config);
      if (!result.valid && result.errors) {
        errors.push(...result.errors);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Validate a single field with specific validator
   */
  validateField(field: string, value: any, validatorType: string): ValidationResult {
    let validator: Validator;

    switch (validatorType) {
      case 'fileSize':
        validator = new FileSizeValidator(this.config);
        break;
      case 'path':
        validator = new PathSafetyValidator(this.config);
        break;
      case 'regex':
        validator = new SafeRegexValidator(this.config);
        break;
      case 'batch':
        validator = new BatchLimitValidator(this.config);
        break;
      default:
        return { valid: true };
    }

    return validator.validate({ [field]: value }, this.config);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ValidationConfig>): void {
    this.config = { ...this.config, ...config };
    this.initializeValidators(); // Re-initialize with new config
  }

  /**
   * Get current configuration
   */
  getConfig(): ValidationConfig {
    return { ...this.config };
  }
}

/**
 * File Size Validator
 * Prevents memory exhaustion by limiting file content size
 */
export class FileSizeValidator implements Validator {
  constructor(private config: ValidationConfig) {}

  validate(params: Record<string, any>): ValidationResult {
    const content = params.content;

    if (content === undefined || content === null) {
      return { valid: true }; // No content to validate
    }

    const sizeInBytes = Buffer.byteLength(String(content), 'utf8');

    if (sizeInBytes > this.config.maxFileSize) {
      return {
        valid: false,
        errors: [{
          field: 'content',
          message: `File size ${this.formatBytes(sizeInBytes)} exceeds maximum allowed size ${this.formatBytes(this.config.maxFileSize)}`,
          code: 'FILE_SIZE_EXCEEDED',
          value: sizeInBytes
        }]
      };
    }

    return { valid: true };
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }
}

/**
 * Path Safety Validator
 * Prevents path traversal and validates path format
 */
export class PathSafetyValidator implements Validator {
  constructor(private config: ValidationConfig) {}

  validate(params: Record<string, any>): ValidationResult {
    const path = params.path;

    if (!path || typeof path !== 'string') {
      return {
        valid: false,
        errors: [{
          field: 'path',
          message: 'Path is required and must be a string',
          code: 'INVALID_PATH',
          value: path
        }]
      };
    }

    const errors: ValidationError[] = [];

    // Check path length
    if (path.length > this.config.maxPathLength) {
      errors.push({
        field: 'path',
        message: `Path length ${path.length} exceeds maximum ${this.config.maxPathLength}`,
        code: 'PATH_TOO_LONG',
        value: path.length
      });
    }

    // Check for path traversal attempts
    if (path.includes('..')) {
      errors.push({
        field: 'path',
        message: 'Path traversal detected (..)',
        code: 'PATH_TRAVERSAL',
        value: path
      });
    }

    // Check for absolute paths
    if (path.startsWith('/') || /^[A-Z]:\\/i.test(path)) {
      errors.push({
        field: 'path',
        message: 'Absolute paths are not allowed',
        code: 'ABSOLUTE_PATH',
        value: path
      });
    }

    // Check for null bytes
    if (path.includes('\x00')) {
      errors.push({
        field: 'path',
        message: 'Path contains null bytes',
        code: 'NULL_BYTE_IN_PATH',
        value: path
      });
    }

    // Check for invalid characters
    const invalidChars = /[<>:"|?*\x00-\x1f]/;
    if (invalidChars.test(path)) {
      errors.push({
        field: 'path',
        message: 'Path contains invalid characters',
        code: 'INVALID_CHARACTERS',
        value: path
      });
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}

/**
 * Safe Regex Validator
 * Prevents ReDoS (Regular Expression Denial of Service) attacks
 */
export class SafeRegexValidator implements Validator {
  constructor(private config: ValidationConfig) {}

  validate(params: Record<string, any>): ValidationResult {
    const query = params.query;

    if (!query || typeof query !== 'string') {
      return { valid: true }; // No regex to validate
    }

    // Check if query contains regex patterns
    if (!this.isRegexPattern(query)) {
      return { valid: true }; // Not a regex, just a plain search
    }

    const errors: ValidationError[] = [];

    try {
      // Test if it's a valid regex
      new RegExp(query);
    } catch (e) {
      errors.push({
        field: 'query',
        message: 'Invalid regular expression syntax',
        code: 'INVALID_REGEX',
        value: query
      });
      return { valid: false, errors };
    }

    // Check for patterns known to cause exponential complexity
    const dangerousPatterns = [
      /(\(.*\+.*\))+/,           // Nested quantifiers like (a+)+
      /(\(.*\*.*\))+/,           // Nested quantifiers like (a*)*
      /(\w+\*)+\w+/,             // Multiple * quantifiers
      /(.+)+/,                   // Greedy quantifiers on captures
      /(.*)*/, // Nested star quantifiers
      /(\w+\|\w+)+/              // Alternation with quantifiers
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(query)) {
        errors.push({
          field: 'query',
          message: 'Regular expression has exponential complexity (potential ReDoS)',
          code: 'REGEX_TOO_COMPLEX',
          value: query
        });
        break;
      }
    }

    // Calculate complexity score
    const complexityScore = this.calculateComplexity(query);
    if (complexityScore > this.config.maxRegexComplexity) {
      errors.push({
        field: 'query',
        message: `Regular expression complexity ${complexityScore} exceeds maximum ${this.config.maxRegexComplexity}`,
        code: 'REGEX_COMPLEXITY_EXCEEDED',
        value: complexityScore
      });
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  private isRegexPattern(query: string): boolean {
    // Check if query contains regex special characters
    return /[.*+?^${}()|[\]\\]/.test(query);
  }

  private calculateComplexity(regex: string): number {
    let score = 0;

    // Count quantifiers
    score += (regex.match(/[*+?{]/g) || []).length * 10;

    // Count groups
    score += (regex.match(/\(/g) || []).length * 5;

    // Count alternations
    score += (regex.match(/\|/g) || []).length * 3;

    // Count backreferences
    score += (regex.match(/\\[0-9]/g) || []).length * 20;

    // Penalize nested groups
    const nestingLevel = this.getNestingLevel(regex);
    score += nestingLevel * 15;

    return score;
  }

  private getNestingLevel(regex: string): number {
    let maxLevel = 0;
    let currentLevel = 0;

    for (const char of regex) {
      if (char === '(') {
        currentLevel++;
        maxLevel = Math.max(maxLevel, currentLevel);
      } else if (char === ')') {
        currentLevel--;
      }
    }

    return maxLevel;
  }
}

/**
 * Batch Limit Validator
 * Prevents DoS by limiting batch operation sizes
 */
export class BatchLimitValidator implements Validator {
  constructor(private config: ValidationConfig) {}

  validate(params: Record<string, any>): ValidationResult {
    // Check paths array
    if (params.paths && Array.isArray(params.paths)) {
      if (params.paths.length > this.config.maxBatchSize) {
        return {
          valid: false,
          errors: [{
            field: 'paths',
            message: `Batch size ${params.paths.length} exceeds maximum ${this.config.maxBatchSize}`,
            code: 'BATCH_SIZE_EXCEEDED',
            value: params.paths.length
          }]
        };
      }
    }

    // Check maxFiles for split operations
    if (params.maxFiles && params.maxFiles > this.config.maxBatchSize) {
      return {
        valid: false,
        errors: [{
          field: 'maxFiles',
          message: `Maximum files ${params.maxFiles} exceeds limit ${this.config.maxBatchSize}`,
          code: 'MAX_FILES_EXCEEDED',
          value: params.maxFiles
        }]
      };
    }

    return { valid: true };
  }
}

/**
 * Content Validator
 * Validates content for proper encoding and format
 */
export class ContentValidator implements Validator {
  constructor(private config: ValidationConfig) {}

  validate(params: Record<string, any>): ValidationResult {
    const content = params.content;

    if (content === undefined || content === null) {
      return { valid: true };
    }

    const errors: ValidationError[] = [];

    // Check if content is a string
    if (typeof content !== 'string') {
      errors.push({
        field: 'content',
        message: 'Content must be a string',
        code: 'INVALID_CONTENT_TYPE',
        value: typeof content
      });
      return { valid: false, errors };
    }

    // Check for valid UTF-8 encoding
    try {
      Buffer.from(content, 'utf8');
    } catch (e) {
      errors.push({
        field: 'content',
        message: 'Content contains invalid UTF-8 sequences',
        code: 'INVALID_UTF8',
        value: content.substring(0, 100)
      });
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}

/**
 * Query Length Validator
 * Prevents excessively long search queries
 */
export class QueryLengthValidator implements Validator {
  private readonly MAX_QUERY_LENGTH = 1000;

  constructor(private config: ValidationConfig) {}

  validate(params: Record<string, any>): ValidationResult {
    const query = params.query;

    if (!query || typeof query !== 'string') {
      return { valid: true };
    }

    if (query.length > this.MAX_QUERY_LENGTH) {
      return {
        valid: false,
        errors: [{
          field: 'query',
          message: `Query length ${query.length} exceeds maximum ${this.MAX_QUERY_LENGTH}`,
          code: 'QUERY_TOO_LONG',
          value: query.length
        }]
      };
    }

    return { valid: true };
  }
}

/**
 * Path Array Validator
 * Validates arrays of paths for batch operations
 */
export class PathArrayValidator implements Validator {
  constructor(private config: ValidationConfig) {}

  validate(params: Record<string, any>): ValidationResult {
    const paths = params.paths;

    if (!paths || !Array.isArray(paths)) {
      return { valid: true };
    }

    const errors: ValidationError[] = [];
    const pathValidator = new PathSafetyValidator(this.config);

    for (let i = 0; i < paths.length; i++) {
      const result = pathValidator.validate({ path: paths[i] });
      if (!result.valid && result.errors) {
        for (const error of result.errors) {
          errors.push({
            ...error,
            field: `paths[${i}]`,
            value: paths[i]
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}

/**
 * Validation Exception
 * Thrown when validation fails
 */
export class ValidationException extends Error {
  constructor(
    public errors: ValidationError[],
    message?: string
  ) {
    super(message || 'Validation failed');
    this.name = 'ValidationException';
  }
}
