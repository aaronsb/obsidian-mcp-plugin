import { z } from 'zod';

/**
 * Converts a JSON Schema property definition to a Zod schema
 */
function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodType {
  const type = prop.type as string;
  const enumValues = prop.enum as string[] | undefined;
  const description = prop.description as string | undefined;

  let schema: z.ZodType;

  // Handle enum types first
  if (enumValues && enumValues.length > 0) {
    schema = z.enum(enumValues as [string, ...string[]]);
  } else if (type === 'string') {
    schema = z.string();
  } else if (type === 'number' || type === 'integer') {
    schema = z.number();
  } else if (type === 'boolean') {
    schema = z.boolean();
  } else if (type === 'array') {
    const items = prop.items as Record<string, unknown> | undefined;
    if (items) {
      schema = z.array(jsonSchemaPropertyToZod(items));
    } else {
      schema = z.array(z.unknown());
    }
  } else if (type === 'object') {
    // Zod v4 record needs key and value schemas
    schema = z.record(z.string(), z.unknown());
  } else {
    // Default to unknown for unrecognized types
    schema = z.unknown();
  }

  // Add description if present
  if (description) {
    schema = schema.describe(description);
  }

  return schema;
}

/**
 * Converts a JSON Schema object definition to a Zod object schema
 */
export function jsonSchemaToZod(jsonSchema: {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
}): z.ZodType {
  const properties = jsonSchema.properties || {};
  const required = new Set(jsonSchema.required || []);

  // Build shape as a mutable object first
  const shape: Record<string, z.ZodType> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let fieldSchema = jsonSchemaPropertyToZod(prop);

    // Make optional if not in required array
    if (!required.has(key)) {
      fieldSchema = fieldSchema.optional();
    }

    shape[key] = fieldSchema;
  }

  return z.object(shape);
}
