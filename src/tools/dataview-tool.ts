import { ObsidianAPI } from '../utils/obsidian-api';
import { PluginDetector } from '../utils/plugin-detector';

/**
 * Dataview plugin API type definitions (not provided by Dataview's package)
 * These model the runtime API surface used by this tool.
 */

/** Dataview's array-like collection with .array() accessor */
interface DataviewArray<T = unknown> {
  length: number;
  array(): T[];
  slice(start?: number, end?: number): DataviewArray<T>;
  map<U>(fn: (item: T) => U): DataviewArray<U>;
}

/** Dataview date/time value with ISO serialization */
interface DataviewDateTime {
  toISOString(): string;
}

/** Dataview link value */
interface DataviewLink {
  path: string;
  display: string;
}

/** Dataview file metadata on a page object */
interface DataviewFileInfo {
  path: string;
  name: string;
  basename?: string;
  extension?: string;
  size: number;
  ctime?: DataviewDateTime;
  mtime?: DataviewDateTime;
  tags?: DataviewArray<string>;
  outlinks?: DataviewArray<DataviewLink>;
  inlinks?: DataviewArray<DataviewLink>;
  tasks?: DataviewArray<DataviewTask>;
  lists?: DataviewArray<unknown>;
}

/** Dataview task item */
interface DataviewTask {
  text: string;
  completed: boolean;
  line: number;
  path: string;
}

/** A Dataview page object (file + frontmatter fields) */
interface DataviewPage {
  file: DataviewFileInfo;
  aliases?: DataviewArray<string>;
  [key: string]: unknown;
}

/** Query result from dataviewAPI.query() */
interface DataviewQueryResult {
  successful?: boolean;
  type: string;
  values?: DataviewArray;
  headers?: string[];
}

/** Row within a table result */
interface DataviewTableRow {
  array(): unknown[];
}

/** The Dataview plugin API surface we consume */
interface DataviewAPI {
  query(dql: string): Promise<DataviewQueryResult>;
  pages(source?: string): DataviewArray<DataviewPage>;
  page(path: string): DataviewPage | null;
}

/** Workflow suggestion shape */
interface WorkflowSuggestion {
  description: string;
  command: string;
  reason: string;
}

/** Workflow response */
interface WorkflowResponse {
  message: string;
  suggested_next: WorkflowSuggestion[];
}

/** Query hints response */
interface QueryHintsResponse {
  performance: string[];
  syntax: string[];
  data: string[];
  alternatives: string[];
}

/** Formatted query result */
interface FormattedQueryResult {
  type: string;
  values?: unknown[];
  headers?: string[];
  data?: DataviewQueryResult;
}

/**
 * Safely cast the detector's unknown API to our typed interface.
 * The Dataview API is a runtime dependency without published types,
 * so we use this helper to bridge the gap.
 */
function asDataviewAPI(api: unknown): DataviewAPI {
  return api as DataviewAPI;
}

/**
 * Dataview tool implementation for querying vault data
 */
export class DataviewTool {
  private detector: PluginDetector;

  constructor(private api: ObsidianAPI) {
    this.detector = new PluginDetector(api.getApp());
  }

  /**
   * Check if Dataview functionality is available
   */
  isAvailable(): boolean {
    return this.detector.isDataviewAPIReady();
  }

  /**
   * Get Dataview status information
   */
  getStatus() {
    return this.detector.getDataviewStatus();
  }

  /**
   * Execute a Dataview query
   */
  async executeQuery(query: string, format: 'dql' | 'js' = 'dql'): Promise<unknown> {
    if (!this.isAvailable()) {
      throw new Error('Dataview plugin is not available or not enabled');
    }

    const dataviewAPI = asDataviewAPI(this.detector.getDataviewAPI());

    try {
      if (format === 'dql') {
        // Execute DQL query
        const result: DataviewQueryResult = await dataviewAPI.query(query);
        return {
          success: true,
          query,
          format,
          result: this.formatQueryResult(result),
          type: result.type || 'unknown',
          workflow: this.generateQueryWorkflow(query, result),
          hints: this.generateQueryHints(query)
        };
      } else {
        // Execute JavaScript query (if needed in the future)
        throw new Error('JavaScript queries not yet implemented');
      }
    } catch (error) {
      return {
        success: false,
        query,
        format,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * List all pages with metadata
   */
  async listPages(source?: string): Promise<unknown> {
    if (!this.isAvailable()) {
      throw new Error('Dataview plugin is not available or not enabled');
    }

    const dataviewAPI = asDataviewAPI(this.detector.getDataviewAPI());

    try {
      // Get pages from source (folder, tag, etc.) or all pages
      const pages: DataviewArray<DataviewPage> = source
        ? dataviewAPI.pages(source)
        : dataviewAPI.pages();

      return {
        success: true,
        source: source || 'all',
        count: pages.length,
        pages: pages.array().slice(0, 50).map((page: DataviewPage) => ({
          path: page.file.path,
          name: page.file.name,
          size: page.file.size,
          created: page.file.ctime?.toISOString(),
          modified: page.file.mtime?.toISOString(),
          tags: page.file.tags?.array() ?? [],
          links: page.file.outlinks?.array()?.length ?? 0,
          aliases: page.aliases?.array() ?? [],
          // Include custom frontmatter fields
          ...this.extractCustomFields(page)
        }))
      };
    } catch (error) {
      return {
        success: false,
        source: source || 'all',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get metadata for a specific page
   */
  async getPageMetadata(path: string): Promise<unknown> {
    if (!this.isAvailable()) {
      throw new Error('Dataview plugin is not available or not enabled');
    }

    const dataviewAPI = asDataviewAPI(this.detector.getDataviewAPI());

    try {
      const page: DataviewPage | null = dataviewAPI.page(path);

      if (!page) {
        throw new Error(`Page not found: ${path}`);
      }

      return {
        success: true,
        path,
        metadata: {
          file: {
            path: page.file.path,
            name: page.file.name,
            basename: page.file.basename,
            extension: page.file.extension,
            size: page.file.size,
            created: page.file.ctime?.toISOString(),
            modified: page.file.mtime?.toISOString()
          },
          tags: page.file.tags?.array() ?? [],
          aliases: page.aliases?.array() ?? [],
          outlinks: page.file.outlinks?.array() ?? [],
          inlinks: page.file.inlinks?.array() ?? [],
          tasks: page.file.tasks?.array()?.length ?? 0,
          lists: page.file.lists?.array()?.length ?? 0,
          // Include all custom frontmatter fields
          custom: this.extractCustomFields(page)
        }
      };
    } catch (error) {
      return {
        success: false,
        path,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Validate a DQL query syntax
   */
  async validateQuery(query: string): Promise<unknown> {
    if (!this.isAvailable()) {
      throw new Error('Dataview plugin is not available or not enabled');
    }

    try {
      // Basic query structure validation
      const trimmedQuery = query.trim();
      const queryTypes = ['LIST', 'TABLE', 'TASK', 'CALENDAR'];
      const firstWord = trimmedQuery.split(/\s+/)[0]?.toUpperCase();

      if (!firstWord || !queryTypes.includes(firstWord)) {
        return {
          valid: false,
          query,
          error: `Query must start with one of: ${queryTypes.join(', ')}`
        };
      }

      return {
        valid: true,
        query,
        queryType: firstWord,
        message: 'Query syntax appears valid'
      };
    } catch (error) {
      return {
        valid: false,
        query,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Format query result for MCP response
   */
  private formatQueryResult(result: DataviewQueryResult): FormattedQueryResult | null {
    if (!result) return null;

    // Handle different result types
    switch (result.type) {
      case 'list':
        return {
          type: 'list',
          values: result.values?.array() ?? []
        };
      case 'table':
        return {
          type: 'table',
          headers: result.headers ?? [],
          values: result.values?.array()?.map((row: unknown) => {
            const tableRow = row as DataviewTableRow;
            return typeof tableRow?.array === 'function' ? tableRow.array() : row;
          }) ?? []
        };
      case 'task':
        return {
          type: 'task',
          values: result.values?.array()?.map((task: unknown) => {
            const dvTask = task as DataviewTask;
            return {
              text: dvTask.text,
              completed: dvTask.completed,
              line: dvTask.line,
              path: dvTask.path
            };
          }) ?? []
        };
      case 'calendar':
        return {
          type: 'calendar',
          values: result.values?.array() ?? []
        };
      default:
        return {
          type: 'unknown',
          data: result
        };
    }
  }

  /**
   * Extract custom frontmatter fields from a page
   */
  private extractCustomFields(page: DataviewPage): Record<string, unknown> {
    const customFields: Record<string, unknown> = {};

    // Standard fields to exclude
    const excludeFields = new Set([
      'file', 'tags', 'aliases', 'outlinks', 'inlinks', 'tasks', 'lists'
    ]);

    // Extract all non-standard fields
    for (const [key, value] of Object.entries(page as Record<string, unknown>)) {
      if (!excludeFields.has(key) && !key.startsWith('$')) {
        // Convert Dataview values to plain JavaScript values
        customFields[key] = this.convertDataviewValue(value);
      }
    }

    return customFields;
  }

  /**
   * Convert Dataview values to plain JavaScript values
   */
  private convertDataviewValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    // Handle Dataview arrays
    const dvArray = value as { array?: () => unknown[] };
    if (typeof dvArray.array === 'function') {
      return dvArray.array().map((item: unknown) => this.convertDataviewValue(item));
    }

    // Handle Dataview dates
    const dvDate = value as { toISOString?: () => string };
    if (typeof dvDate.toISOString === 'function') {
      return dvDate.toISOString();
    }

    // Handle Dataview links
    const dvLink = value as { path?: string; display?: string };
    if (dvLink.path && dvLink.display) {
      return {
        path: dvLink.path,
        display: dvLink.display
      };
    }

    return value;
  }

  /**
   * Generate workflow suggestions for query results
   */
  private generateQueryWorkflow(query: string, result: DataviewQueryResult): WorkflowResponse {
    const queryType = query.trim().split(/\s+/)[0]?.toUpperCase();
    const suggestions: WorkflowSuggestion[] = [];

    // Base suggestions for all query types
    suggestions.push({
      description: 'View Dataview query reference',
      command: 'system(action="fetch_resource", uri="obsidian://dataview-reference")',
      reason: 'Learn more DQL syntax and examples'
    });

    switch (queryType) {
      case 'LIST':
        suggestions.push({
          description: 'Convert to TABLE for more details',
          command: `dataview(action="query", query="${query.replace('LIST', 'TABLE file.size, file.mtime')}")`,
          reason: 'See file metadata alongside results'
        });
        break;
      case 'TABLE':
        suggestions.push({
          description: 'Filter results with WHERE clause',
          command: `dataview(action="query", query="${query} WHERE file.size > 1000")`,
          reason: 'Narrow down results based on criteria'
        });
        break;
      case 'TASK':
        suggestions.push({
          description: 'Show only incomplete tasks',
          command: `dataview(action="query", query="${query} WHERE !completed")`,
          reason: 'Focus on pending tasks'
        });
        break;
    }

    // Add sorting suggestion if not already present
    if (!query.toLowerCase().includes('sort')) {
      suggestions.push({
        description: 'Sort results by modification date',
        command: `dataview(action="query", query="${query} SORT file.mtime DESC")`,
        reason: 'Show most recently modified files first'
      });
    }

    return {
      message: `${queryType ?? 'Unknown'} query executed successfully${result.successful === false ? ' with warnings' : ''}`,
      suggested_next: suggestions.slice(0, 3) // Limit to 3 suggestions
    };
  }

  /**
   * Generate query optimization hints
   */
  private generateQueryHints(query: string): QueryHintsResponse {
    const hints: string[] = [];
    const queryLower = query.toLowerCase();

    // Performance hints
    if (!queryLower.includes('limit') && !queryLower.includes('where')) {
      hints.push('Consider adding LIMIT clause for large vaults to improve performance');
    }

    if (queryLower.includes('from ""') || queryLower.includes('from "."')) {
      hints.push('Querying all files can be slow - consider filtering by folder or tag');
    }

    // Syntax hints
    if (queryLower.includes('where') && !queryLower.includes('sort')) {
      hints.push('Add SORT clause to order filtered results (e.g., SORT file.mtime DESC)');
    }

    if (queryLower.includes('table') && !queryLower.includes('as ')) {
      hints.push('Use AS keyword to rename columns (e.g., file.size AS "Size (bytes)")');
    }

    // Data type hints
    if (queryLower.includes('rating') || queryLower.includes('priority')) {
      hints.push('Custom frontmatter fields like rating/priority need to be defined in your notes');
    }

    return {
      performance: hints.filter(h => h.includes('performance') || h.includes('slow')),
      syntax: hints.filter(h => h.includes('SORT') || h.includes('AS') || h.includes('LIMIT')),
      data: hints.filter(h => h.includes('frontmatter') || h.includes('defined')),
      alternatives: this.generateAlternativeQueries(query)
    };
  }

  /**
   * Generate alternative query suggestions
   */
  private generateAlternativeQueries(query: string): string[] {
    const alternatives: string[] = [];
    const queryType = query.trim().split(/\s+/)[0]?.toUpperCase();

    switch (queryType) {
      case 'LIST':
        alternatives.push(query.replace('LIST', 'TABLE file.size, file.mtime'));
        alternatives.push(query.replace('LIST', 'CALENDAR file.ctime'));
        break;
      case 'TABLE':
        alternatives.push(query.replace(/TABLE.*FROM/, 'LIST FROM'));
        if (!query.toLowerCase().includes('group by')) {
          alternatives.push(query + ' GROUP BY file.folder');
        }
        break;
      case 'TASK':
        alternatives.push(query.replace('TASK', 'LIST'));
        break;
    }

    return alternatives.slice(0, 2); // Limit alternatives
  }

  /**
   * Generate Dataview reference content for MCP resource
   */
  static generateDataviewReference(): string {
    return `# Dataview Query Language (DQL) Reference

## Query Types

### LIST
Lists files matching criteria
\`\`\`
LIST FROM "folder"
LIST FROM #tag
LIST FROM [[Note]] AND #tag
LIST FROM "folder" WHERE rating > 3
LIST FROM #project WHERE status = "active" SORT file.mtime DESC
\`\`\`

### TABLE
Displays data in tabular format
\`\`\`
TABLE file.size, file.mtime FROM "Notes"
TABLE rating, status, file.name FROM #project
TABLE author, published AS "Year" FROM #books WHERE rating >= 4
TABLE length(file.outlinks) AS "Links" FROM "Research"
\`\`\`

### TASK
Shows tasks from notes
\`\`\`
TASK FROM "Projects"
TASK FROM #todo WHERE !completed
TASK FROM "Daily Notes" WHERE contains(text, "urgent")
\`\`\`

### CALENDAR
Calendar view of dates
\`\`\`
CALENDAR file.ctime FROM "Daily Notes"
CALENDAR created FROM #meeting
CALENDAR due FROM #project WHERE !completed
\`\`\`

## Common Fields

### File Fields
- \`file.path\` - Full file path
- \`file.name\` - File name with extension
- \`file.basename\` - File name without extension
- \`file.size\` - File size in bytes
- \`file.ctime\` - Creation time
- \`file.mtime\` - Modification time
- \`file.folder\` - Parent folder
- \`file.outlinks\` - Outgoing links
- \`file.inlinks\` - Incoming links
- \`file.tags\` - File tags

### Custom Fields
Any frontmatter field can be used:
- \`rating\` - Custom rating field
- \`status\` - Project status
- \`author\` - Book author
- \`priority\` - Task priority
- \`due\` - Due date

## Operators

### Comparison
- \`=\` - Equal
- \`!=\` - Not equal
- \`>\`, \`>=\` - Greater than (or equal)
- \`<\`, \`<=\` - Less than (or equal)

### Logical
- \`AND\` - Both conditions true
- \`OR\` - Either condition true
- \`!\` - Not (negation)

### Text
- \`contains(field, "text")\` - Contains text
- \`startswith(field, "prefix")\` - Starts with
- \`endswith(field, "suffix")\` - Ends with
- \`regexmatch(field, "pattern")\` - Regex match

## Functions

### Date Functions
- \`date(today)\` - Today's date
- \`date("2024-01-01")\` - Specific date
- \`dur(1 week)\` - Duration
- \`dateformat(date, "yyyy-MM-dd")\` - Format date

### List Functions
- \`length(list)\` - List length
- \`sum(numbers)\` - Sum of numbers
- \`min(numbers)\` - Minimum value
- \`max(numbers)\` - Maximum value

### Text Functions
- \`upper(text)\` - Uppercase
- \`lower(text)\` - Lowercase
- \`split(text, "separator")\` - Split text

## Sorting & Grouping

### SORT
\`\`\`
SORT file.mtime DESC
SORT rating ASC, file.name
SORT length(file.outlinks) DESC
\`\`\`

### GROUP BY
\`\`\`
GROUP BY file.folder
GROUP BY author
GROUP BY status
\`\`\`

### LIMIT
\`\`\`
LIMIT 10
LIMIT 5
\`\`\`

## Example Queries

### Project Management
\`\`\`
TABLE status, priority, file.mtime FROM #project
WHERE status != "completed"
SORT priority DESC, file.mtime DESC
\`\`\`

### Book Library
\`\`\`
TABLE author, rating, file.name FROM #books
WHERE rating >= 4
GROUP BY author
SORT rating DESC
\`\`\`

### Daily Notes Analysis
\`\`\`
CALENDAR file.ctime FROM "Daily Notes"
WHERE file.ctime >= date(today) - dur(30 days)
\`\`\`

### Task Tracking
\`\`\`
TASK FROM #todo
WHERE !completed AND contains(text, "urgent")
SORT file.mtime DESC
\`\`\`

## Tips

1. **Performance**: Use WHERE clauses and LIMIT for large vaults
2. **Folders**: Use quotes for folder names with spaces
3. **Tags**: Prefix with # for tag queries
4. **Links**: Use [[Note Name]] syntax for link queries
5. **Custom Fields**: Define in YAML frontmatter of notes
6. **Dates**: Use ISO format (YYYY-MM-DD) for date fields
7. **Escaping**: Use backslashes for special characters in strings

## Common Patterns

### Find Recent Files
\`\`\`
LIST FROM "Notes"
WHERE file.mtime >= date(today) - dur(7 days)
SORT file.mtime DESC
\`\`\`

### Files Without Tags
\`\`\`
LIST FROM "Notes"
WHERE length(file.tags) = 0
\`\`\`

### High-Value Content
\`\`\`
TABLE rating, length(file.inlinks) AS "Backlinks"
FROM #important
WHERE rating > 3
SORT length(file.inlinks) DESC
\`\`\`
`;
  }
}

/**
 * Check if Dataview is available for tool registration
 */
export function isDataviewToolAvailable(api: ObsidianAPI): boolean {
  const detector = new PluginDetector(api.getApp());
  return detector.isDataviewAPIReady();
}
