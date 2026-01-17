/**
 * Type definitions for Obsidian Bases integration
 */

export interface BaseFile {
  path: string;
  name: string;
  views: string[];
  properties: BaseProperty[];
  noteCount: number;
  created: number;
  modified: number;
}

export interface BaseConfig {
  name: string;
  source: string | string[]; // Folder paths or tags to include
  properties: BaseProperty[];
  views: BaseViewConfig[];
  filters?: BaseFilter[];
  defaultView?: string;
}

export interface BaseProperty {
  key: string;
  type: BasePropertyType;
  formula?: string; // For calculated properties
  required?: boolean;
  defaultValue?: unknown;
  displayName?: string;
  description?: string;
}

export type BasePropertyType = 
  | 'text' 
  | 'number' 
  | 'date' 
  | 'checkbox' 
  | 'list' 
  | 'formula'
  | 'link'
  | 'tags';

export interface BaseViewConfig {
  name: string;
  type: BaseViewType;
  columns?: string[]; // For table view
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  groupBy?: string;
  filters?: BaseFilter[];
  cardSize?: 'small' | 'medium' | 'large'; // For card view
  showContent?: boolean;
  limit?: number;
}

export type BaseViewType = 
  | 'table' 
  | 'card' 
  | 'list' 
  | 'calendar'
  | 'kanban'
  | 'gallery';

export interface BaseView {
  name: string;
  type: BaseViewType;
  data: BaseNote[];
  config: BaseViewConfig;
  total: number;
}

export interface BaseFilter {
  property: string;
  operator: FilterOperator;
  value: unknown;
  caseSensitive?: boolean;
}

export type FilterOperator = 
  | 'equals' 
  | 'not_equals'
  | 'contains' 
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt' 
  | 'gte'
  | 'lt' 
  | 'lte'
  | 'between' 
  | 'in' 
  | 'not_in'
  | 'is_empty'
  | 'is_not_empty';

export interface BaseQueryOptions {
  filters?: BaseFilter[];
  sort?: BaseSortOptions;
  pagination?: BasePaginationOptions;
  includeContent?: boolean;
  properties?: string[]; // Specific properties to include
}

export interface BaseSortOptions {
  property: string;
  order: 'asc' | 'desc';
}

export interface BasePaginationOptions {
  page: number;
  pageSize: number;
}

export interface BaseQueryResult {
  notes: BaseNote[];
  total: number;
  page?: number;
  pageSize?: number;
  hasMore?: boolean;
}

export interface BaseNote {
  path: string;
  title: string;
  properties: Record<string, unknown>;
  content?: string; // Optional, for performance
  tags?: string[];
  links?: string[];
  created: number;
  modified: number;
}

export interface BaseTemplate {
  name: string;
  folder?: string;
  fileNameFormat?: string; // e.g., "{{date}}-{{title}}"
  properties: Record<string, unknown>;
  contentTemplate?: string;
}

export interface BaseExportOptions {
  format: 'csv' | 'json' | 'markdown';
  properties?: string[]; // Specific properties to export
  includeContent?: boolean;
  dateFormat?: string;
}

export interface BaseFormulaContext {
  note: BaseNote;
  allNotes: BaseNote[];
  functions: BaseFormulaFunctions;
}

export interface BaseFormulaFunctions {
  sum: (property: string) => number;
  avg: (property: string) => number;
  count: (filter?: BaseFilter) => number;
  min: (property: string) => number;
  max: (property: string) => number;
  concat: (...values: string[]) => string;
  date: (value: unknown) => Date;
  days_between: (date1: Date, date2: Date) => number;
}

export interface BaseError {
  code: BaseErrorCode;
  message: string;
  details?: unknown;
}

export type BaseErrorCode = 
  | 'BASE_NOT_FOUND'
  | 'INVALID_BASE_CONFIG'
  | 'PROPERTY_TYPE_MISMATCH'
  | 'FORMULA_ERROR'
  | 'FILTER_ERROR'
  | 'EXPORT_ERROR'
  | 'PERMISSION_DENIED'
  | 'BASES_NOT_AVAILABLE';

export interface BaseCapabilities {
  available: boolean;
  version?: string;
  features: {
    formulas: boolean;
    templates: boolean;
    export: boolean;
    customViews: boolean;
  };
}