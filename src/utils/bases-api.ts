import { App, TFile, TFolder, getAllTags, parseFrontMatterEntry, parseFrontMatterStringArray } from 'obsidian';
import {
  BaseFile,
  BaseConfig,
  BaseNote,
  BaseQueryOptions,
  BaseQueryResult,
  BaseView,
  BaseFilter,
  BaseTemplate,
  BaseExportOptions,
  BaseCapabilities,
  BaseError,
  BaseViewConfig,
  FilterOperator
} from '../types/bases';
import { Debug } from './debug';

/**
 * API for interacting with Obsidian Bases functionality
 */
export class BasesAPI {
  private app: App;
  private baseCache: Map<string, BaseFile> = new Map();

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Check if Bases functionality is available
   */
  async getCapabilities(): Promise<BaseCapabilities> {
    // Check if Bases plugin is enabled
    const basesPlugin = (this.app as any).plugins?.plugins?.['obsidian-bases'];
    const isAvailable = !!basesPlugin;

    return {
      available: isAvailable,
      version: basesPlugin?.manifest?.version,
      features: {
        formulas: isAvailable,
        templates: isAvailable,
        export: isAvailable,
        customViews: isAvailable
      }
    };
  }

  /**
   * List all bases in the vault
   */
  async listBases(): Promise<BaseFile[]> {
    const bases: BaseFile[] = [];
    const files = this.app.vault.getFiles();

    for (const file of files) {
      if (file.extension === 'base') {
        const base = await this.parseBaseFile(file);
        if (base) {
          bases.push(base);
        }
      }
    }

    return bases;
  }

  /**
   * Get a specific base by path
   */
  async getBase(path: string): Promise<BaseFile> {
    // Check cache first
    if (this.baseCache.has(path)) {
      return this.baseCache.get(path)!;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile) || file.extension !== 'base') {
      throw this.createError('BASE_NOT_FOUND', `Base file not found: ${path}`);
    }

    const base = await this.parseBaseFile(file);
    if (!base) {
      throw this.createError('INVALID_BASE_CONFIG', `Invalid base configuration: ${path}`);
    }

    this.baseCache.set(path, base);
    return base;
  }

  /**
   * Create a new base from configuration
   */
  async createBase(config: BaseConfig): Promise<BaseFile> {
    // Validate configuration
    this.validateBaseConfig(config);

    // Create base file path
    const basePath = `${config.name}.base`;
    
    // Check if base already exists
    const existingFile = this.app.vault.getAbstractFileByPath(basePath);
    if (existingFile) {
      throw this.createError('BASE_EXISTS', `Base already exists: ${basePath}`);
    }

    // Create base file content
    const baseContent = JSON.stringify(config, null, 2);
    await this.app.vault.create(basePath, baseContent);

    // Parse and return the created base
    const file = this.app.vault.getAbstractFileByPath(basePath) as TFile;
    const base = await this.parseBaseFile(file);
    
    if (!base) {
      throw this.createError('BASE_CREATION_FAILED', 'Failed to create base');
    }

    return base;
  }

  /**
   * Update an existing base configuration
   */
  async updateBase(path: string, config: Partial<BaseConfig>): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile) || file.extension !== 'base') {
      throw this.createError('BASE_NOT_FOUND', `Base file not found: ${path}`);
    }

    // Get existing configuration
    const existingConfig = await this.readBaseConfig(file);
    
    // Merge configurations
    const updatedConfig = { ...existingConfig, ...config };
    
    // Validate merged configuration
    this.validateBaseConfig(updatedConfig);

    // Update file
    const content = JSON.stringify(updatedConfig, null, 2);
    await this.app.vault.modify(file, content);

    // Clear cache
    this.baseCache.delete(path);
  }

  /**
   * Delete a base
   */
  async deleteBase(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile) || file.extension !== 'base') {
      throw this.createError('BASE_NOT_FOUND', `Base file not found: ${path}`);
    }

    await this.app.vault.delete(file);
    this.baseCache.delete(path);
  }

  /**
   * Query a base with filters and options
   */
  async queryBase(path: string, options?: BaseQueryOptions): Promise<BaseQueryResult> {
    const base = await this.getBase(path);
    const config = await this.readBaseConfig(this.app.vault.getAbstractFileByPath(path) as TFile);
    
    // Get source notes
    let notes = await this.getSourceNotes(config);

    // Apply filters
    if (options?.filters && options.filters.length > 0) {
      notes = this.applyFilters(notes, options.filters);
    }

    // Apply sorting
    if (options?.sort) {
      notes = this.sortNotes(notes, options.sort.property, options.sort.order);
    }

    // Calculate total before pagination
    const total = notes.length;

    // Apply pagination
    let page: number | undefined;
    let pageSize: number | undefined;
    let hasMore = false;

    if (options?.pagination) {
      page = options.pagination.page;
      pageSize = options.pagination.pageSize;
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      notes = notes.slice(start, end);
      hasMore = end < total;
    }

    // Filter properties if specified
    if (options?.properties) {
      notes = notes.map(note => ({
        ...note,
        properties: this.filterProperties(note.properties, options.properties!)
      }));
    }

    // Include/exclude content based on options
    if (!options?.includeContent) {
      notes = notes.map(note => {
        const { content, ...noteWithoutContent } = note;
        return noteWithoutContent;
      });
    }

    return {
      notes,
      total,
      page,
      pageSize,
      hasMore
    };
  }

  /**
   * Get a specific view of a base
   */
  async getBaseView(path: string, viewName: string): Promise<BaseView> {
    const base = await this.getBase(path);
    const config = await this.readBaseConfig(this.app.vault.getAbstractFileByPath(path) as TFile);

    // Find view configuration
    const viewConfig = config.views.find(v => v.name === viewName);
    if (!viewConfig) {
      throw this.createError('VIEW_NOT_FOUND', `View not found: ${viewName}`);
    }

    // Query base with view filters
    const queryOptions: BaseQueryOptions = {
      filters: viewConfig.filters,
      sort: viewConfig.sortBy ? {
        property: viewConfig.sortBy,
        order: viewConfig.sortOrder || 'asc'
      } : undefined,
      includeContent: viewConfig.showContent,
      properties: viewConfig.columns
    };

    const result = await this.queryBase(path, queryOptions);

    return {
      name: viewName,
      type: viewConfig.type,
      data: result.notes,
      config: viewConfig,
      total: result.total
    };
  }

  /**
   * Generate a note from base template
   */
  async generateFromTemplate(basePath: string, template: BaseTemplate): Promise<TFile> {
    const base = await this.getBase(basePath);
    
    // Generate file name
    const fileName = this.generateFileName(template);
    const folder = template.folder || '';
    const filePath = folder ? `${folder}/${fileName}.md` : `${fileName}.md`;

    // Check if file already exists
    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
    if (existingFile) {
      throw this.createError('FILE_EXISTS', `File already exists: ${filePath}`);
    }

    // Generate content
    let content = '';

    // Add frontmatter with properties
    if (Object.keys(template.properties).length > 0) {
      content += '---\n';
      for (const [key, value] of Object.entries(template.properties)) {
        content += `${key}: ${this.formatPropertyValue(value)}\n`;
      }
      content += '---\n\n';
    }

    // Add content template
    if (template.contentTemplate) {
      content += this.processTemplate(template.contentTemplate, template.properties);
    }

    // Create file
    const file = await this.app.vault.create(filePath, content);
    return file;
  }

  /**
   * Export base data in specified format
   */
  async exportBase(path: string, options: BaseExportOptions): Promise<string> {
    const result = await this.queryBase(path, {
      includeContent: options.includeContent,
      properties: options.properties
    });

    switch (options.format) {
      case 'csv':
        return this.exportToCSV(result.notes, options);
      case 'json':
        return this.exportToJSON(result.notes, options);
      case 'markdown':
        return this.exportToMarkdown(result.notes, options);
      default:
        throw this.createError('EXPORT_ERROR', `Unsupported export format: ${options.format}`);
    }
  }

  // Private helper methods

  private async parseBaseFile(file: TFile): Promise<BaseFile | null> {
    try {
      const content = await this.app.vault.read(file);
      const config = JSON.parse(content) as BaseConfig;
      
      // Get source notes to count them
      const notes = await this.getSourceNotes(config);

      return {
        path: file.path,
        name: config.name,
        views: config.views.map(v => v.name),
        properties: config.properties,
        noteCount: notes.length,
        created: file.stat.ctime,
        modified: file.stat.mtime
      };
    } catch (error) {
      Debug.log(`Failed to parse base file ${file.path}:`, error);
      return null;
    }
  }

  private async readBaseConfig(file: TFile): Promise<BaseConfig> {
    const content = await this.app.vault.read(file);
    return JSON.parse(content) as BaseConfig;
  }

  private async getSourceNotes(config: BaseConfig): Promise<BaseNote[]> {
    const notes: BaseNote[] = [];
    const sources = Array.isArray(config.source) ? config.source : [config.source];

    for (const source of sources) {
      if (source.startsWith('#')) {
        // Tag-based source
        const tag = source;
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
          const cache = this.app.metadataCache.getFileCache(file);
          const tags = cache ? getAllTags(cache) : null;
          if (tags?.includes(tag)) {
            const note = await this.fileToBaseNote(file);
            notes.push(note);
          }
        }
      } else {
        // Folder-based source
        const folder = this.app.vault.getAbstractFileByPath(source);
        if (folder && folder instanceof TFolder) {
          const files = this.getMarkdownFilesInFolder(folder);
          for (const file of files) {
            const note = await this.fileToBaseNote(file);
            notes.push(note);
          }
        }
      }
    }

    return notes;
  }

  private getMarkdownFilesInFolder(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'md') {
        files.push(child);
      } else if (child instanceof TFolder) {
        files.push(...this.getMarkdownFilesInFolder(child));
      }
    }

    return files;
  }

  private async fileToBaseNote(file: TFile): Promise<BaseNote> {
    const content = await this.app.vault.read(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter || {};
    
    return {
      path: file.path,
      title: file.basename,
      properties: { ...frontmatter },
      content: content,
      tags: cache ? (getAllTags(cache) || []) : [],
      links: cache?.links?.map(l => l.link) || [],
      created: file.stat.ctime,
      modified: file.stat.mtime
    };
  }

  private applyFilters(notes: BaseNote[], filters: BaseFilter[]): BaseNote[] {
    return notes.filter(note => {
      for (const filter of filters) {
        if (!this.matchesFilter(note, filter)) {
          return false;
        }
      }
      return true;
    });
  }

  private matchesFilter(note: BaseNote, filter: BaseFilter): boolean {
    const value = note.properties[filter.property];
    const filterValue = filter.value;

    switch (filter.operator) {
      case 'equals':
        return value === filterValue;
      case 'not_equals':
        return value !== filterValue;
      case 'contains':
        return String(value).includes(String(filterValue));
      case 'not_contains':
        return !String(value).includes(String(filterValue));
      case 'starts_with':
        return String(value).startsWith(String(filterValue));
      case 'ends_with':
        return String(value).endsWith(String(filterValue));
      case 'gt':
        return Number(value) > Number(filterValue);
      case 'gte':
        return Number(value) >= Number(filterValue);
      case 'lt':
        return Number(value) < Number(filterValue);
      case 'lte':
        return Number(value) <= Number(filterValue);
      case 'between': {
        const [min, max] = filterValue;
        return Number(value) >= Number(min) && Number(value) <= Number(max);
      }
      case 'in':
        return Array.isArray(filterValue) && filterValue.includes(value);
      case 'not_in':
        return Array.isArray(filterValue) && !filterValue.includes(value);
      case 'is_empty':
        return value === null || value === undefined || value === '';
      case 'is_not_empty':
        return value !== null && value !== undefined && value !== '';
      default:
        return true;
    }
  }

  private sortNotes(notes: BaseNote[], property: string, order: 'asc' | 'desc'): BaseNote[] {
    return notes.sort((a, b) => {
      const aValue = a.properties[property];
      const bValue = b.properties[property];

      if (aValue === bValue) return 0;
      if (aValue === null || aValue === undefined) return 1;
      if (bValue === null || bValue === undefined) return -1;

      const comparison = aValue < bValue ? -1 : 1;
      return order === 'asc' ? comparison : -comparison;
    });
  }

  private filterProperties(properties: Record<string, any>, filter: string[]): Record<string, any> {
    const filtered: Record<string, any> = {};
    for (const key of filter) {
      if (key in properties) {
        filtered[key] = properties[key];
      }
    }
    return filtered;
  }

  private validateBaseConfig(config: BaseConfig): void {
    if (!config.name) {
      throw this.createError('INVALID_BASE_CONFIG', 'Base name is required');
    }
    if (!config.source) {
      throw this.createError('INVALID_BASE_CONFIG', 'Base source is required');
    }
    if (!config.properties || config.properties.length === 0) {
      throw this.createError('INVALID_BASE_CONFIG', 'At least one property is required');
    }
    if (!config.views || config.views.length === 0) {
      throw this.createError('INVALID_BASE_CONFIG', 'At least one view is required');
    }
  }

  private generateFileName(template: BaseTemplate): string {
    let fileName = template.fileNameFormat || '{{title}}';
    
    // Replace template variables
    fileName = fileName.replace('{{date}}', new Date().toISOString().split('T')[0]);
    fileName = fileName.replace('{{timestamp}}', Date.now().toString());
    fileName = fileName.replace('{{title}}', template.properties.title || 'Untitled');
    
    // Replace any property references
    for (const [key, value] of Object.entries(template.properties)) {
      fileName = fileName.replace(`{{${key}}}`, String(value));
    }

    return fileName;
  }

  private formatPropertyValue(value: any): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return `"${value}"`;
    if (Array.isArray(value)) return `[${value.map(v => this.formatPropertyValue(v)).join(', ')}]`;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  private processTemplate(template: string, properties: Record<string, any>): string {
    let result = template;
    
    for (const [key, value] of Object.entries(properties)) {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
    }

    return result;
  }

  private exportToCSV(notes: BaseNote[], options: BaseExportOptions): string {
    if (notes.length === 0) return '';

    // Get headers
    const properties = options.properties || Object.keys(notes[0].properties);
    const headers = ['title', 'path', ...properties];

    // Build CSV
    const rows: string[] = [];
    rows.push(headers.join(','));

    for (const note of notes) {
      const row = [
        this.escapeCSV(note.title),
        this.escapeCSV(note.path),
        ...properties.map(p => this.escapeCSV(note.properties[p]))
      ];
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }

  private escapeCSV(value: any): string {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  private exportToJSON(notes: BaseNote[], options: BaseExportOptions): string {
    const data = notes.map(note => ({
      title: note.title,
      path: note.path,
      properties: options.properties 
        ? this.filterProperties(note.properties, options.properties)
        : note.properties,
      ...(options.includeContent ? { content: note.content } : {})
    }));

    return JSON.stringify(data, null, 2);
  }

  private exportToMarkdown(notes: BaseNote[], options: BaseExportOptions): string {
    const lines: string[] = [];
    
    lines.push('# Base Export');
    lines.push('');

    for (const note of notes) {
      lines.push(`## ${note.title}`);
      lines.push(`Path: ${note.path}`);
      lines.push('');

      // Add properties
      if (Object.keys(note.properties).length > 0) {
        lines.push('### Properties');
        for (const [key, value] of Object.entries(note.properties)) {
          if (!options.properties || options.properties.includes(key)) {
            lines.push(`- **${key}**: ${value}`);
          }
        }
        lines.push('');
      }

      // Add content if requested
      if (options.includeContent && note.content) {
        lines.push('### Content');
        lines.push(note.content);
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  private createError(code: string, message: string, details?: any): BaseError {
    return {
      code: code as any,
      message,
      details
    };
  }
}