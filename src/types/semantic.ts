/**
 * Types for the semantic workflow system
 * 
 * IMPORTANT: All workflow hints and suggestions are OPTIONAL guidance.
 * Agents and users are free to:
 * - Ignore suggestions completely
 * - Repeat the same operation multiple times  
 * - Choose their own path through the tools
 * - Follow user instructions that override hints
 * 
 * The semantic hints are designed to suggest efficient patterns and
 * prevent common mistakes, but they are NOT prescriptive or mandatory.
 */

export interface SemanticResponse<T = unknown> {
  // The actual operation result
  result: T;
  
  // Workflow guidance
  workflow?: {
    message: string;
    suggested_next: SuggestedAction[];
  };
  
  // Current context information
  context?: {
    current_file?: string;
    current_directory?: string;
    buffer_available?: boolean;
    search_results?: number;
    linked_files?: string[];
    tags?: string[];
  };
  
  // Efficiency hints
  efficiency_hints?: {
    message: string;
    alternatives?: string[];
  };
  
  // Warnings or important notices
  warnings?: string[];
  
  // Error information with recovery hints
  error?: {
    code: string;
    message: string;
    recovery_hints?: SuggestedAction[];
  };
}

export interface SuggestedAction {
  description: string;
  command: string;
  reason?: string;
  requires_tokens?: string; // Token condition that must be met
}

export interface WorkflowConfig {
  version: string;
  description: string;
  operations: Record<string, OperationConfig>;
  efficiency_rules?: EfficiencyRule[];
  context_triggers?: Record<string, string>;
}

export interface OperationConfig {
  description: string;
  actions: Record<string, ActionConfig>;
}

export interface ActionConfig {
  description: string;
  parameters?: {
    required?: string[];
    optional?: string[];
  };
  success_hints?: HintConfig;
  failure_hints?: HintConfig;
}

export interface HintConfig {
  message: string;
  suggested_next: ConditionalSuggestions[];
}

export interface ConditionalSuggestions {
  condition: string;
  suggestions: SuggestedAction[];
}

export interface EfficiencyRule {
  pattern: string;
  hint: string;
}

export interface SemanticContext {
  operation?: string;
  action?: string;
  last_file?: string;
  last_directory?: string;
  buffer_content?: string;
  search_history?: string[];
  file_history?: string[];
}

export interface SemanticRequest {
  operation: string;
  action: string;
  params: Record<string, unknown>;
}