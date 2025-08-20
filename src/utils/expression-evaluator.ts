import { App, TFile, getAllTags } from 'obsidian';
import { NoteContext } from '../types/bases-yaml';
import { Debug } from './debug';

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
  async evaluate(expression: string, context: NoteContext): Promise<any> {
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
          Debug.log('status value:', evalContext.status || evalContext.note?.status);
        }
        if (expression.includes('priority')) {
          Debug.log('priority value:', evalContext.priority || evalContext.note?.priority);
        }
      }
      
      // Parse and evaluate the expression
      // For now, we'll use a simple approach with Function constructor
      // In production, consider using a proper expression parser like jsep
      const func = new Function(...Object.keys(evalContext), `return ${expression}`);
      const result = func(...Object.values(evalContext));
      
      if (Debug.isDebugMode()) {
        Debug.log(`Expression result: ${result}`);
      }
      
      return result;
    } catch (error) {
      Debug.log(`Expression evaluation failed for: ${expression}`, error);
      return false;
    }
  }

  /**
   * Create the evaluation context with all available variables and functions
   */
  private createEvalContext(context: NoteContext): Record<string, any> {
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
      links: cache?.links?.map((l: any) => l.link) || [],
      
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
        const links = cache?.links || [];
        // Handle both [[Link]] and Link formats
        const normalizedTarget = target.replace(/^\[\[|\]\]$/g, '');
        return links.some((link: any) => link.link === normalizedTarget);
      },
      
      hasProperty: (name: string) => {
        return name in frontmatter;
      }
    };

    // Global functions
    const globalFunctions = {
      // Date/time functions
      date: (str: string) => new Date(str),
      now: () => new Date(),
      today: () => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
      },
      
      // Type conversion
      number: (val: any) => Number(val),
      string: (val: any) => String(val),
      
      // Utility functions
      if: (condition: any, trueVal: any, falseVal: any = null) => {
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
      list: (val: any) => Array.isArray(val) ? val : [val]
    };

    // Build the complete context
    const evalContext: Record<string, any> = {
      ...globalFunctions,
      file: fileObj,
      note: frontmatter, // note properties
      formula: formulas || {}, // formula results
      
      // Allow direct access to frontmatter properties
      ...frontmatter
    };

    return evalContext;
  }

  /**
   * Parse a property path like "file.name" or "note.status"
   */
  resolvePropertyPath(path: string, context: NoteContext): any {
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

  private resolveFileProperty(prop: string, context: NoteContext): any {
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
        return cache?.links?.map((l: any) => l.link) || [];
      default:
        return undefined;
    }
  }

  private resolveFrontmatterProperty(prop: string, context: NoteContext): any {
    return context.frontmatter[prop];
  }
}