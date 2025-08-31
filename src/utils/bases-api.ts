import { App, TFile, TFolder, getAllTags } from 'obsidian';
import * as yaml from 'js-yaml';
import {
  BaseYAML,
  FilterExpression,
  ViewConfig,
  NoteContext,
  BaseQueryResult,
  EvaluatedNote,
  FileProperties
} from '../types/bases-yaml';
import { Debug } from './debug';
import { ExpressionEvaluator } from './expression-evaluator';
import { FormulaEngine } from './formula-engine';

/**
 * Bases API implementation that matches Obsidian's actual Bases behavior
 */
export class BasesAPI {
  private app: App;
  private expressionEvaluator: ExpressionEvaluator;
  private formulaEngine: FormulaEngine;

  constructor(app: App) {
    this.app = app;
    this.expressionEvaluator = new ExpressionEvaluator(app);
    this.formulaEngine = new FormulaEngine(app);
  }

  /**
   * List all .base files in the vault
   */
  async listBases(): Promise<Array<{ path: string; name: string; views: string[] }>> {
    const bases: Array<{ path: string; name: string; views: string[] }> = [];
    const files = this.app.vault.getFiles();

    for (const file of files) {
      if (file.extension === 'base') {
        try {
          const content = await this.app.vault.read(file);
          const baseConfig = yaml.load(content) as BaseYAML;
          
          bases.push({
            path: file.path,
            name: file.basename,
            views: baseConfig.views?.map(v => v.name) || []
          });
        } catch (error) {
          Debug.log(`Failed to parse base file ${file.path}:`, error);
        }
      }
    }

    return bases;
  }

  /**
   * Read and parse a base file
   */
  async readBase(path: string): Promise<BaseYAML> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile) || file.extension !== 'base') {
      throw new Error(`Base file not found: ${path}`);
    }

    const content = await this.app.vault.read(file);
    try {
      return yaml.load(content) as BaseYAML;
    } catch (error) {
      throw new Error(`Invalid YAML in base file: ${error}`);
    }
  }

  /**
   * Create a new base file
   */
  async createBase(path: string, config: BaseYAML): Promise<void> {
    // Validate configuration
    if (!config.views || config.views.length === 0) {
      throw new Error('Base must have at least one view');
    }

    // Convert to YAML
    const yamlContent = yaml.dump(config, {
      lineWidth: -1, // Don't wrap lines
      noRefs: true,  // Don't use YAML references
      quotingType: '"', // Use double quotes
      forceQuotes: false // Only quote when necessary
    });

    // Create the file
    await this.app.vault.create(path, yamlContent);
  }

  /**
   * Query a base with optional view
   */
  async queryBase(basePath: string, viewName?: string): Promise<BaseQueryResult> {
    const baseConfig = await this.readBase(basePath);
    
    // Get the specified view or the first one
    let view: ViewConfig | undefined;
    if (viewName) {
      view = baseConfig.views.find(v => v.name === viewName);
      if (!view) {
        throw new Error(`View not found: ${viewName}`);
      }
    } else {
      view = baseConfig.views[0];
    }

    // Get all markdown files in the vault
    const files = this.app.vault.getMarkdownFiles();
    let notes: EvaluatedNote[] = [];

    // Process each file
    for (const file of files) {
      const context = await this.createNoteContext(file, baseConfig);
      
      // Apply global filters
      if (baseConfig.filters && !await this.evaluateFilter(baseConfig.filters, context)) {
        continue;
      }

      // Apply view filters
      if (view?.filters && !await this.evaluateFilter(view.filters, context)) {
        continue;
      }

      // Create evaluated note
      const evaluatedNote = await this.createEvaluatedNote(file, context, baseConfig);
      notes.push(evaluatedNote);
    }

    // Apply sorting
    if (view?.order && view.order.length > 0) {
      notes = this.sortNotes(notes, view.order);
    }

    // Apply limit
    if (view?.limit) {
      notes = notes.slice(0, view.limit);
    }

    return {
      notes,
      total: notes.length,
      view
    };
  }

  /**
   * Export base data in various formats
   */
  async exportBase(basePath: string, format: 'csv' | 'json' | 'markdown', viewName?: string): Promise<string> {
    const result = await this.queryBase(basePath, viewName);

    switch (format) {
      case 'csv':
        return this.exportToCSV(result);
      case 'json':
        return this.exportToJSON(result);
      case 'markdown':
        return this.exportToMarkdown(result);
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  // Private helper methods

  /**
   * Parse frontmatter from file content
   */
  private parseFrontmatter(content: string): Record<string, any> {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---/;
    const match = content.match(frontmatterRegex);
    
    if (!match) {
      return {};
    }
    
    try {
      // Parse YAML frontmatter
      const frontmatterText = match[1];
      const parsed = yaml.load(frontmatterText);
      
      // Ensure we return an object
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, any>;
      }
      
      return {};
    } catch (error) {
      Debug.log('Failed to parse frontmatter:', error);
      return {};
    }
  }

  private async createNoteContext(file: TFile, baseConfig: BaseYAML): Promise<NoteContext> {
    const cache = this.app.metadataCache.getFileCache(file);
    
    // Debug logging to understand what's in the cache
    if (Debug.isDebugMode()) {
      Debug.log(`Cache for ${file.path}:`, {
        hasCache: !!cache,
        hasFrontmatter: !!(cache?.frontmatter),
        frontmatterKeys: cache?.frontmatter ? Object.keys(cache.frontmatter) : [],
        hasFrontmatterPosition: !!(cache?.frontmatterPosition),
        cacheStructure: cache ? Object.keys(cache) : []
      });
    }
    
    // Use Obsidian's cached frontmatter when available
    // The metadata cache should have already parsed this for us
    let frontmatter = cache?.frontmatter || {};
    
    // Only parse manually if cache is unavailable (rare edge case)
    // This might happen if the file was just created or cache is stale
    if (!cache || Object.keys(frontmatter).length === 0) {
      // Force a cache refresh first
      await this.app.metadataCache.trigger('resolve', file);
      
      // Try cache again after refresh
      const refreshedCache = this.app.metadataCache.getFileCache(file);
      frontmatter = refreshedCache?.frontmatter || {};
      
      // Last resort: manual parse (should rarely happen)
      if (Object.keys(frontmatter).length === 0) {
        const content = await this.app.vault.read(file);
        frontmatter = this.parseFrontmatter(content);
      }
    }

    const context: NoteContext = {
      file,
      frontmatter,
      cache
    };

    // Evaluate formulas if defined
    if (baseConfig.formulas) {
      context.formulas = {};
      for (const [name, expression] of Object.entries(baseConfig.formulas)) {
        try {
          context.formulas[name] = await this.formulaEngine.evaluate(expression, context);
        } catch (error) {
          Debug.log(`Formula evaluation failed for ${name}:`, error);
          context.formulas[name] = null;
        }
      }
    }

    return context;
  }

  private async evaluateFilter(filter: FilterExpression, context: NoteContext): Promise<boolean> {
    if (typeof filter === 'string') {
      // Evaluate expression string
      return await this.expressionEvaluator.evaluate(filter, context);
    }

    // Handle logical operators
    if ('and' in filter) {
      for (const subFilter of filter.and) {
        if (!await this.evaluateFilter(subFilter, context)) {
          return false;
        }
      }
      return true;
    }

    if ('or' in filter) {
      for (const subFilter of filter.or) {
        if (await this.evaluateFilter(subFilter, context)) {
          return true;
        }
      }
      return false;
    }

    if ('not' in filter) {
      for (const subFilter of filter.not) {
        if (await this.evaluateFilter(subFilter, context)) {
          return false;
        }
      }
      return true;
    }

    return true;
  }

  private async createEvaluatedNote(file: TFile, context: NoteContext, baseConfig: BaseYAML): Promise<EvaluatedNote> {
    const fileProps = this.getFileProperties(file, context.cache);
    
    // Combine all properties
    const properties: Record<string, any> = {
      ...context.frontmatter
    };

    // Add file properties with prefix
    for (const [key, value] of Object.entries(fileProps)) {
      properties[`file.${key}`] = value;
    }

    // Add formula properties with prefix
    if (context.formulas) {
      for (const [key, value] of Object.entries(context.formulas)) {
        properties[`formula.${key}`] = value;
      }
    }

    return {
      path: file.path,
      name: file.basename,
      properties,
      frontmatter: context.frontmatter,
      file: fileProps,
      formulas: context.formulas
    };
  }

  private getFileProperties(file: TFile, cache: any): FileProperties {
    const tags = cache ? (getAllTags(cache) || []) : [];
    const links = cache?.links?.map((l: any) => l.link) || [];

    return {
      name: file.basename,
      path: file.path,
      folder: file.parent?.path || '',
      ext: file.extension,
      size: file.stat.size,
      ctime: file.stat.ctime,
      mtime: file.stat.mtime,
      tags,
      links,
      // Note: backlinks are expensive, only compute if needed
      // backlinks: this.getBacklinks(file)
    };
  }

  private sortNotes(notes: EvaluatedNote[], order: string[]): EvaluatedNote[] {
    return notes.sort((a, b) => {
      for (const prop of order) {
        const aVal = this.getPropertyValue(a, prop);
        const bVal = this.getPropertyValue(b, prop);

        if (aVal === bVal) continue;
        if (aVal == null) return 1;
        if (bVal == null) return -1;

        if (aVal < bVal) return -1;
        if (aVal > bVal) return 1;
      }
      return 0;
    });
  }

  private getPropertyValue(note: EvaluatedNote, path: string): any {
    // Handle different property paths
    if (path.startsWith('file.')) {
      const prop = path.substring(5);
      return (note.file as any)[prop];
    } else if (path.startsWith('formula.')) {
      const prop = path.substring(8);
      return note.formulas?.[prop];
    } else if (path.startsWith('note.')) {
      const prop = path.substring(5);
      return note.frontmatter[prop];
    } else {
      // Default to frontmatter
      return note.frontmatter[path];
    }
  }

  private exportToCSV(result: BaseQueryResult): string {
    if (result.notes.length === 0) return '';

    // Get columns from view or use all properties
    const columns = result.view?.columns || 
      Object.keys(result.notes[0].properties);

    // Build CSV
    const rows: string[] = [];
    
    // Header
    rows.push(columns.map(c => this.escapeCSV(c)).join(','));

    // Data rows
    for (const note of result.notes) {
      const values = columns.map(col => {
        const value = this.getPropertyValue(note, col);
        return this.escapeCSV(value);
      });
      rows.push(values.join(','));
    }

    return rows.join('\n');
  }

  private exportToJSON(result: BaseQueryResult): string {
    return JSON.stringify(result.notes, null, 2);
  }

  private exportToMarkdown(result: BaseQueryResult): string {
    const lines: string[] = [];
    
    // Header
    lines.push(`# Base Export: ${result.view?.name || 'All Notes'}`);
    lines.push('');
    lines.push(`Total results: ${result.total}`);
    lines.push('');

    // Table
    if (result.notes.length > 0) {
      const columns = result.view?.columns || Object.keys(result.notes[0].properties);
      
      // Header row
      lines.push('| ' + columns.join(' | ') + ' |');
      lines.push('| ' + columns.map(() => '---').join(' | ') + ' |');

      // Data rows
      for (const note of result.notes) {
        const values = columns.map(col => {
          const value = this.getPropertyValue(note, col);
          return String(value ?? '');
        });
        lines.push('| ' + values.join(' | ') + ' |');
      }
    }

    return lines.join('\n');
  }

  private escapeCSV(value: any): string {
    if (value == null) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }
}