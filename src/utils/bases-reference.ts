/**
 * Shared reference data for Obsidian Bases
 * This provides semantic hints and documentation for error handling
 */

export interface FunctionReference {
  name: string;
  syntax: string;
  description: string;
  examples: string[];
  category: 'date' | 'string' | 'number' | 'list' | 'file' | 'global';
}

export interface PropertyReference {
  prefix: string;
  properties: Record<string, string>;
  description: string;
}

export class BasesReference {
  private static readonly functions: FunctionReference[] = [
    // Date Functions
    {
      name: 'date',
      syntax: 'date(string)',
      description: 'Parse a date string into a Date object',
      examples: ['date("2025-03-15")', 'date(due_date)'],
      category: 'date'
    },
    {
      name: 'now',
      syntax: 'now()',
      description: 'Get the current date and time',
      examples: ['now()', '(due_date - now()) / 86400000'],
      category: 'date'
    },
    {
      name: 'today',
      syntax: 'today()',
      description: 'Get today\'s date at midnight',
      examples: ['today()', 'start_date >= today()'],
      category: 'date'
    },
    
    // Global Functions
    {
      name: 'iff',
      syntax: 'iff(condition, true_value, false_value)',
      description: 'Conditional expression (renamed from "if" to avoid reserved word)',
      examples: ['iff(priority > 3, "High", "Low")', 'iff(status == "active", 1, 0)'],
      category: 'global'
    },
    {
      name: 'choice',
      syntax: 'choice(condition, true_value, false_value)',
      description: 'Alternative to iff for conditional expressions',
      examples: ['choice(completed, "Done", "Pending")'],
      category: 'global'
    },
    {
      name: 'number',
      syntax: 'number(value)',
      description: 'Convert a value to a number',
      examples: ['number("42")', 'number(priority)'],
      category: 'global'
    },
    {
      name: 'string',
      syntax: 'string(value)',
      description: 'Convert a value to a string',
      examples: ['string(42)', 'string(team_size) + " people"'],
      category: 'global'
    },
    {
      name: 'list',
      syntax: 'list(value)',
      description: 'Convert a value to a list/array',
      examples: ['list(tags)', 'list("single-item")'],
      category: 'global'
    },
    
    // Math Functions
    {
      name: 'min',
      syntax: 'min(...values)',
      description: 'Get the minimum value',
      examples: ['min(1, 2, 3)', 'min(priority, 5)'],
      category: 'number'
    },
    {
      name: 'max',
      syntax: 'max(...values)',
      description: 'Get the maximum value',
      examples: ['max(1, 2, 3)', 'max(completion, 0)'],
      category: 'number'
    },
    {
      name: 'abs',
      syntax: 'abs(number)',
      description: 'Get the absolute value',
      examples: ['abs(-5)', 'abs(days_overdue)'],
      category: 'number'
    },
    {
      name: 'round',
      syntax: 'round(number, digits?)',
      description: 'Round a number to specified digits',
      examples: ['round(3.14159, 2)', 'round(completion / 10)'],
      category: 'number'
    }
  ];

  private static readonly properties: PropertyReference[] = [
    {
      prefix: 'file',
      description: 'File metadata properties',
      properties: {
        'file.name': 'File name without extension',
        'file.path': 'Full path to the file',
        'file.folder': 'Parent folder path',
        'file.ext': 'File extension',
        'file.size': 'File size in bytes',
        'file.ctime': 'Creation timestamp',
        'file.mtime': 'Modification timestamp',
        'file.tags': 'Array of tags from the file',
        'file.links': 'Array of outgoing links',
        'file.hasTag(tag)': 'Check if file has a specific tag',
        'file.inFolder(path)': 'Check if file is in a folder',
        'file.hasLink(target)': 'Check if file links to target',
        'file.hasProperty(name)': 'Check if file has a frontmatter property'
      }
    },
    {
      prefix: 'note',
      description: 'Note frontmatter properties',
      properties: {
        'note.<property>': 'Access any frontmatter property',
        'status': 'Direct access to status property',
        'priority': 'Direct access to priority property',
        'due_date': 'Direct access to due_date property'
      }
    },
    {
      prefix: 'formula',
      description: 'Calculated formula results',
      properties: {
        'formula.<name>': 'Access a calculated formula value'
      }
    }
  ];

  private static readonly commonErrors = new Map<string, string>([
    ['Unexpected token', 'Check for reserved JavaScript keywords. Use "iff" instead of "if", ensure strings are quoted properly.'],
    ['is not defined', 'Property may not exist in frontmatter. Check spelling and ensure the property exists in your notes.'],
    ['Cannot read property', 'Trying to access a property that doesn\'t exist. Use optional chaining (?.) or check existence first.'],
    ['Invalid date', 'Date string format may be incorrect. Use ISO format (YYYY-MM-DD) or wrap in date() function.'],
    ['NaN', 'Mathematical operation on non-numeric value. Ensure dates are parsed with date() and values are numbers.']
  ]);

  /**
   * Get function reference by name
   */
  static getFunction(name: string): FunctionReference | undefined {
    return this.functions.find(f => f.name === name);
  }

  /**
   * Get all functions in a category
   */
  static getFunctionsByCategory(category: string): FunctionReference[] {
    return this.functions.filter(f => f.category === category);
  }

  /**
   * Get property reference by prefix
   */
  static getPropertyReference(prefix: string): PropertyReference | undefined {
    return this.properties.find(p => p.prefix === prefix);
  }

  /**
   * Generate semantic error hint based on error message
   */
  static getErrorHint(error: Error | string, context?: { expression?: string; property?: string }): {
    error: string;
    hint: string;
    suggestions: string[];
    examples?: string[];
  } {
    const errorMsg = typeof error === 'string' ? error : error.message;
    
    // Build suggestions based on error type
    const suggestions: string[] = [];
    const examples: string[] = [];
    let hint = '';

    // Check for common error patterns
    for (const [pattern, suggestion] of this.commonErrors) {
      if (errorMsg.includes(pattern)) {
        hint = suggestion;
        break;
      }
    }

    // Context-specific suggestions
    if (context?.expression) {
      // Check for date-related issues
      if (context.expression.includes('due_date') || context.expression.includes('date')) {
        suggestions.push('Wrap date strings in date() function: date("2025-03-15")');
        suggestions.push('For date math, use: (date(due_date) - now()) / 86400000');
        examples.push('date(due_date)', '(date(due_date) - now()) / 86400000');
      }

      // Check for reserved words
      if (context.expression.includes(' if(') || context.expression.includes(' if ')) {
        suggestions.push('Use "iff" or "choice" instead of "if" (reserved word)');
        examples.push('iff(status == "active", "Yes", "No")', 'choice(priority > 3, "High", "Low")');
      }

      // Check for property access
      if (errorMsg.includes('is not defined')) {
        const match = errorMsg.match(/(\w+) is not defined/);
        if (match) {
          const prop = match[1];
          suggestions.push(`Ensure "${prop}" exists in your note's frontmatter`);
          suggestions.push(`Try accessing with note.${prop} or file.${prop}`);
          suggestions.push('Check property spelling and capitalization');
        }
      }
    }

    // Add function references if relevant
    if (errorMsg.includes('date') || errorMsg.includes('NaN')) {
      const dateFuncs = this.getFunctionsByCategory('date');
      examples.push(...dateFuncs.flatMap(f => f.examples));
    }

    return {
      error: errorMsg,
      hint: hint || 'Check expression syntax and property names',
      suggestions,
      examples: examples.length > 0 ? examples : undefined
    };
  }

  /**
   * Get reference documentation for MCP resource
   */
  static getFullReference(): string {
    let doc = '# Obsidian Bases Function Reference\\n\\n';
    
    // Group functions by category
    const categories = ['global', 'date', 'number', 'string', 'list', 'file'];
    
    for (const category of categories) {
      const funcs = this.getFunctionsByCategory(category);
      if (funcs.length === 0) continue;
      
      doc += `## ${category.charAt(0).toUpperCase() + category.slice(1)} Functions\\n\\n`;
      
      for (const func of funcs) {
        doc += `### ${func.syntax}\\n`;
        doc += `${func.description}\\n\\n`;
        doc += 'Examples:\\n';
        for (const example of func.examples) {
          doc += `- \`${example}\`\\n`;
        }
        doc += '\\n';
      }
    }
    
    // Add property references
    doc += '## Property References\\n\\n';
    for (const prop of this.properties) {
      doc += `### ${prop.prefix} Properties\\n`;
      doc += `${prop.description}\\n\\n`;
      for (const [key, desc] of Object.entries(prop.properties)) {
        doc += `- \`${key}\`: ${desc}\\n`;
      }
      doc += '\\n';
    }
    
    return doc;
  }
}