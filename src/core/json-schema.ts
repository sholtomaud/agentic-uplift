/**
 * Zero-dependency JSON Schema subset validator for verifying all emitted
 * agentic JSON contracts (`status.json`, `audit.json`, `proof.json`, `gate.json`).
 * Layer 2 (`src/core/`).
 */
import { isRecord } from '../shared/contracts.ts';

function matchesType(value: unknown, expected: string): boolean {
  if (expected === 'null') return value === null;
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'string') return typeof value === 'string';
  if (expected === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (expected === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return isRecord(value);
  return false;
}

function resolveRef(
  rootSchema: Record<string, unknown>,
  ref: string
): Record<string, unknown> | null {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let current: unknown = rootSchema;
  for (const part of parts) {
    if (!isRecord(current) || !(part in current)) return null;
    current = current[part];
  }
  return isRecord(current) ? current : null;
}

function validateNode(
  value: unknown,
  schema: Record<string, unknown>,
  rootSchema: Record<string, unknown>,
  pointer: string,
  errors: string[]
): void {
  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(rootSchema, schema.$ref);
    if (!resolved) {
      errors.push(`${pointer}: unresolved $ref "${schema.$ref}"`);
      return;
    }
    validateNode(value, resolved, rootSchema, pointer, errors);
    return;
  }

  if ('const' in schema && value !== schema.const) {
    errors.push(
      `${pointer}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`
    );
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(
      `${pointer}: value ${JSON.stringify(value)} not in enum [${schema.enum.map((e) => JSON.stringify(e)).join(', ')}]`
    );
    return;
  }

  if (typeof schema.type === 'string') {
    if (!matchesType(value, schema.type)) {
      errors.push(`${pointer}: expected type ${schema.type}`);
      return;
    }
  } else if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t): t is string => typeof t === 'string');
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${pointer}: expected one of types [${types.join(', ')}]`);
      return;
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${pointer}: ${value} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${pointer}: ${value} > maximum ${schema.maximum}`);
    }
  }

  if (typeof value === 'string') {
    if (
      typeof schema.minLength === 'number' &&
      value.length < schema.minLength
    ) {
      errors.push(
        `${pointer}: string length ${value.length} < minLength ${schema.minLength}`
      );
    }
  }

  if (Array.isArray(value) && isRecord(schema.items)) {
    for (let i = 0; i < value.length; i += 1) {
      validateNode(
        value[i],
        schema.items,
        rootSchema,
        `${pointer}[${i}]`,
        errors
      );
    }
  }

  if (isRecord(value)) {
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (typeof req === 'string' && !(req in value)) {
          errors.push(`${pointer}: missing required property "${req}"`);
        }
      }
    }

    const props = isRecord(schema.properties) ? schema.properties : null;
    if (props) {
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in value && isRecord(propSchema)) {
          validateNode(
            value[key],
            propSchema,
            rootSchema,
            `${pointer}.${key}`,
            errors
          );
        }
      }
    }

    if (schema.additionalProperties === false && props) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          errors.push(`${pointer}: unexpected property "${key}"`);
        }
      }
    }
  }
}

export function validateJsonSchema(
  value: unknown,
  schema: unknown
): readonly string[] {
  if (!isRecord(schema)) {
    return ['$ : schema must be an object'];
  }
  const errors: string[] = [];
  validateNode(value, schema, schema, '$', errors);
  return errors;
}
