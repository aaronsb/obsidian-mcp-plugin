/**
 * Type definitions for Obsidian Bases YAML format
 * Based on official Obsidian Bases syntax documentation
 */

/**
 * Root structure of a .base file
 */
export interface BaseYAML {
  /**
   * Global filters applied to all views
   */
  filters?: FilterExpression;
  
  /**
   * Formula definitions for calculated properties
   */
  formulas?: Record<string, string>;
  
  /**
   * Property display configurations
   */
  properties?: Record<string, PropertyConfig>;
  
  /**
   * List of views (required, at least one)
   */
  views: ViewConfig[];
}

/**
 * Filter expression - can be string or logical operator object
 */
export type FilterExpression = 
  | string // Expression like 'status == "active"' or 'file.hasTag("project")'
  | { and: FilterExpression[] }
  | { or: FilterExpression[] }
  | { not: FilterExpression[] };

/**
 * Property configuration (mainly display settings)
 */
export interface PropertyConfig {
  displayName?: string;
}

/**
 * View configuration
 */
export interface ViewConfig {
  /**
   * View type - table or cards (more coming)
   */
  type: 'table' | 'cards';
  
  /**
   * Display name for the view
   */
  name: string;
  
  /**
   * View-specific filters
   */
  filters?: FilterExpression;
  
  /**
   * Sort order - array of property paths
   */
  order?: string[];
  
  /**
   * Limit number of results
   */
  limit?: number;
  
  // Table-specific properties
  /**
   * Columns to display (table view)
   */
  columns?: string[];
  
  // Cards-specific properties
  /**
   * Property containing image for card cover
   */
  imageProperty?: string;
  
  /**
   * How to fit the image
   */
  imageFit?: 'cover' | 'contain';
  
  /**
   * Aspect ratio for card images
   */
  imageAspectRatio?: string;
}

/**
 * Context for evaluating expressions and formulas
 */
export interface NoteContext {
  /**
   * The file being evaluated
   */
  file: import('obsidian').TFile;

  /**
   * Frontmatter properties from the note
   */
  frontmatter: Record<string, unknown>;

  /**
   * Calculated formula values
   */
  formulas?: Record<string, unknown>;

  /**
   * File metadata cache
   */
  cache?: import('obsidian').CachedMetadata;
}

/**
 * Result of evaluating a base query
 */
export interface BaseQueryResult {
  notes: EvaluatedNote[];
  total: number;
  view?: ViewConfig;
}

/**
 * A note with evaluated properties
 */
export interface EvaluatedNote {
  /**
   * File path
   */
  path: string;
  
  /**
   * File name without extension
   */
  name: string;
  
  /**
   * All properties (note, file, and formula)
   */
  properties: Record<string, unknown>;
  
  /**
   * Raw frontmatter
   */
  frontmatter: Record<string, unknown>;
  
  /**
   * File properties
   */
  file: FileProperties;
  
  /**
   * Evaluated formulas
   */
  formulas?: Record<string, unknown>;
}

/**
 * File properties accessible in expressions
 */
export interface FileProperties {
  name: string;
  path: string;
  folder: string;
  ext: string;
  size: number;
  ctime: number;
  mtime: number;
  tags: string[];
  links: string[];
  backlinks?: string[];
}