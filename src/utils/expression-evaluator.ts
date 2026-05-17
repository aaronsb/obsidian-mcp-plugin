import { App, getAllTags, LinkCache } from 'obsidian';
import { parse, eval as evaluateAst } from 'expression-eval';
import { NoteContext } from '../types/bases-yaml';
import { Debug } from './debug';
import { BasesReference } from './bases-reference';

/**
 * Member names that bridge from a plain value to the `Function` constructor
 * (`x.constructor.constructor("…")()`) or the prototype chain. expression-eval
 * 5.x already blocks `constructor`/`__proto__` internally; this denylist is
 * defense-in-depth that (a) also covers `prototype`, (b) covers the computed
 * form `x["constructor"]`, and (c) does not silently weaken if the pinned
 * library's internal list changes. ADR-201's "explicit, tested no-globals
 * safety property" lives here, not in a transitive dependency.
 */
const FORBIDDEN_MEMBERS = new Set(['constructor', '__proto__', 'prototype']);

/** Minimal structural view of the jsep AST nodes we need to walk. */
interface AstNode {
  type: string;
  [key: string]: unknown;
}

/**
 * Reject any member access whose property resolves to a forbidden name,
 * whether written as `a.constructor` (Identifier) or `a["constructor"]`
 * (computed Literal). Throws so the caller's existing catch returns the
 * evaluator's safe `false` — a blocked `.base` expression fails closed,
 * exactly as a malformed one already does.
 */
function assertNoForbiddenAccess(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  const n = node as AstNode;

  // `this` resolves to the whole evaluation context object — no legitimate
  // use in a `.base` filter/formula, and a needless reflection surface. Reject.
  if (n.type === 'ThisExpression') {
    throw new Error('`this` is not allowed in Bases expressions');
  }

  if (n.type === 'MemberExpression') {
    const property = n.property as AstNode | undefined;
    const computed = n.computed === true;
    const name =
      !computed && property?.type === 'Identifier'
        ? (property.name as string)
        : computed && property?.type === 'Literal'
          ? String(property.value)
          : undefined;
    if (name !== undefined && FORBIDDEN_MEMBERS.has(name)) {
      throw new Error(`Access to member "${name}" is not allowed`);
    }
  }

  for (const value of Object.values(n)) {
    if (Array.isArray(value)) {
      value.forEach(assertNoForbiddenAccess);
    } else if (value && typeof value === 'object') {
      assertNoForbiddenAccess(value);
    }
  }
}

/**
 * Evaluates Bases filter and formula expressions
 * Supports JavaScript-like syntax with property access and function calls
 */
export class ExpressionEvaluator {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Evaluate an expression string in the context of a note
   */
  evaluate(expression: string, context: NoteContext): unknown {
    try {
      // Create a safe evaluation context
      const evalContext = this.createEvalContext(context);
      
      // Debug logging
      if (Debug.isDebugMode()) {
        Debug.log(`Evaluating expression: "${expression}"`);
        Debug.log('Context frontmatter:', context.frontmatter);
        Debug.log('Available context keys:', Object.keys(evalContext));

        // Log specific values that might be referenced in the expression
        if (expression.includes('status')) {
          Debug.log('status value:', evalContext['status'] || (evalContext['note'] as Record<string, unknown> | undefined)?.['status']);
        }
        if (expression.includes('priority')) {
          Debug.log('priority value:', evalContext['priority'] || (evalContext['note'] as Record<string, unknown> | undefined)?.['priority']);
        }
      }
      
      // Parse with expression-eval (jsep grammar — no `eval`/`Function`/`new`
      // and no global scope), reject prototype-chain escapes, then evaluate
      // against the curated context. `.base` files are synced/shareable, so
      // this must not execute arbitrary JS (ADR-201).
      const ast = parse(expression);
      assertNoForbiddenAccess(ast);
      const result: unknown = evaluateAst(ast, evalContext);
      
      if (Debug.isDebugMode()) {
        Debug.log(`Expression result: ${String(result)}`);
      }
      
      return result;
    } catch (error) {
      const errorHint = BasesReference.getErrorHint(error as Error, { expression });
      
      Debug.log(`Expression evaluation failed for: ${expression}`);
      Debug.log(`Error: ${errorHint.error}`);
      Debug.log(`Hint: ${errorHint.hint}`);
      
      if (errorHint.suggestions.length > 0) {
        Debug.log('Suggestions:', errorHint.suggestions);
      }
      
      if (errorHint.examples && errorHint.examples.length > 0) {
        Debug.log('Examples:', errorHint.examples);
      }
      
      return false;
    }
  }

  /**
   * Create the evaluation context with all available variables and functions
   */
  private createEvalContext(context: NoteContext): Record<string, unknown> {
    const { file, frontmatter, formulas, cache } = context;
    
    // File properties object
    const fileObj = {
      name: file.basename,
      path: file.path,
      folder: file.parent?.path || '',
      ext: file.extension,
      size: file.stat.size,
      ctime: new Date(file.stat.ctime),
      mtime: new Date(file.stat.mtime),
      tags: cache ? (getAllTags(cache) || []) : [],
      links: cache?.links?.map((l: LinkCache) => l.link) || [],

      // File functions
      hasTag: (...tags: string[]) => {
        const fileTags = cache ? (getAllTags(cache) || []) : [];
        return tags.some(tag => {
          // Handle both with and without # prefix
          const normalizedTag = tag.startsWith('#') ? tag : `#${tag}`;
          return fileTags.includes(normalizedTag);
        });
      },
      
      inFolder: (folder: string) => {
        const filePath = file.path;
        // Handle both with and without trailing slash
        const normalizedFolder = folder.endsWith('/') ? folder : folder + '/';
        return filePath.startsWith(normalizedFolder);
      },
      
      hasLink: (target: string) => {
        const links: LinkCache[] = cache?.links || [];
        // Handle both [[Link]] and Link formats
        const normalizedTarget = target.replace(/^\[\[|\]\]$/g, '');
        return links.some((link: LinkCache) => link.link === normalizedTarget);
      },
      
      hasProperty: (name: string) => {
        return name in frontmatter;
      }
    };

    // Global functions
    const globalFunctions = {
      // Date/time functions
      date: (str: string | Date) => {
        // If already a Date, return it
        if (str instanceof Date) return str;
        // Parse string to Date
        const parsed = new Date(str);
        if (isNaN(parsed.getTime())) {
          Debug.log(`Failed to parse date: ${str}`);
          return null;
        }
        return parsed;
      },
      now: () => new Date(),
      today: () => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
      },
      
      // Type conversion
      number: (val: unknown) => Number(val),
      string: (val: unknown) => String(val),
      
      // Utility functions - renamed to avoid reserved word conflicts
      iff: (condition: unknown, trueVal: unknown, falseVal: unknown = null) => {
        return condition ? trueVal : falseVal;
      },
      choice: (condition: unknown, trueVal: unknown, falseVal: unknown = null) => {
        return condition ? trueVal : falseVal;
      },
      
      // Math functions
      min: (...values: number[]) => Math.min(...values),
      max: (...values: number[]) => Math.max(...values),
      abs: (n: number) => Math.abs(n),
      round: (n: number, digits: number = 0) => {
        const factor = Math.pow(10, digits);
        return Math.round(n * factor) / factor;
      },
      
      // List functions
      list: (val: unknown): unknown[] => Array.isArray(val) ? val as unknown[] : [val]
    };

    // Pre-process frontmatter to auto-convert date-like strings
    const processedFrontmatter: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(frontmatter)) {
      // Auto-convert date-like properties
      if (typeof value === 'string' && 
          (key.includes('date') || key.includes('Date') || 
           key === 'due' || key === 'start' || key === 'end' || 
           key === 'created' || key === 'modified')) {
        // Try to parse as date
        const parsed = new Date(value);
        if (!isNaN(parsed.getTime())) {
          processedFrontmatter[key] = parsed;
        } else {
          processedFrontmatter[key] = value;
        }
      } else {
        processedFrontmatter[key] = value;
      }
    }

    // Build the complete context
    const evalContext: Record<string, unknown> = {
      ...globalFunctions,
      file: fileObj,
      note: processedFrontmatter, // note properties with dates parsed
      formula: formulas || {}, // formula results
      
      // Allow direct access to frontmatter properties
      ...processedFrontmatter
    };

    return evalContext;
  }

  /**
   * Parse a property path like "file.name" or "note.status"
   */
  resolvePropertyPath(path: string, context: NoteContext): unknown {
    const parts = path.split('.');
    
    if (parts[0] === 'file') {
      return this.resolveFileProperty(parts.slice(1).join('.'), context);
    } else if (parts[0] === 'note') {
      return this.resolveFrontmatterProperty(parts.slice(1).join('.'), context);
    } else if (parts[0] === 'formula') {
      return context.formulas?.[parts.slice(1).join('.')];
    } else {
      // Default to frontmatter
      return context.frontmatter[path];
    }
  }

  private resolveFileProperty(prop: string, context: NoteContext): unknown {
    const { file, cache } = context;
    
    switch (prop) {
      case 'name':
        return file.basename;
      case 'path':
        return file.path;
      case 'folder':
        return file.parent?.path || '';
      case 'ext':
        return file.extension;
      case 'size':
        return file.stat.size;
      case 'ctime':
        return new Date(file.stat.ctime);
      case 'mtime':
        return new Date(file.stat.mtime);
      case 'tags':
        return cache ? (getAllTags(cache) || []) : [];
      case 'links':
        return cache?.links?.map((l: LinkCache) => l.link) || [];
      default:
        return undefined;
    }
  }

  private resolveFrontmatterProperty(prop: string, context: NoteContext): unknown {
    return context.frontmatter[prop];
  }
}