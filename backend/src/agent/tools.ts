import toolsFile from './tool-definitions.json';
import type { RunType } from './agent-queue.service';

export type ToolAccess = 'READ' | 'WRITE' | 'GATED';

export interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
  items?: JsonSchema;
  description?: string;
  default?: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface ToolDef {
  access: ToolAccess;
  runTypes: RunType[];
  tool: ToolSpec;
}

export const TOOL_DEFS: ToolDef[] = (toolsFile as unknown as { tools: ToolDef[] }).tools;
export const TOOLS_BY_NAME = new Map(TOOL_DEFS.map((t) => [t.tool.name, t]));

/** The Claude tool definitions offered to a given run type (the access/runTypes tags are stripped). */
export function toolsForRun(runType: RunType): ToolSpec[] {
  const effective = runType === 'MANUAL' ? 'NIGHTLY_DIGEST' : runType;
  return TOOL_DEFS.filter((t) => t.runTypes.includes(effective)).map((t) => t.tool);
}

export function isToolAllowed(name: string, runType: RunType): boolean {
  const def = TOOLS_BY_NAME.get(name);
  const effective = runType === 'MANUAL' ? 'NIGHTLY_DIGEST' : runType;
  return !!def && def.runTypes.includes(effective);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates tool input against the subset of JSON Schema used in tools.json.
 * Returns the cleaned input (unknown keys dropped, defaults applied) or a list of errors
 * that is sent back to the model so it can correct the call.
 */
export function validateInput(schema: JsonSchema, input: unknown): { ok: true; value: any } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const value = check(schema, input, '', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function check(s: JsonSchema, v: unknown, at: string, errors: string[]): unknown {
  const where = at || 'input';
  if (s.enum && !s.enum.includes(v)) {
    errors.push(`${where} must be one of ${s.enum.join(', ')}`);
    return v;
  }
  switch (s.type) {
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        errors.push(`${where} must be an object`);
        return v;
      }
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const r of s.required ?? []) if (obj[r] === undefined || obj[r] === null) errors.push(`${at ? at + '.' : ''}${r} is required`);
      for (const [k, sub] of Object.entries(s.properties ?? {})) {
        if (obj[k] === undefined || obj[k] === null) {
          if (sub.default !== undefined) out[k] = sub.default;
          continue;
        }
        out[k] = check(sub, obj[k], at ? `${at}.${k}` : k, errors);
      }
      return out;
    }
    case 'string': {
      if (typeof v !== 'string') {
        errors.push(`${where} must be a string`);
        return v;
      }
      if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${where} must be at most ${s.maxLength} characters`);
      if (s.format === 'uuid' && !UUID.test(v)) errors.push(`${where} must be a UUID`);
      if (s.format === 'email' && !EMAIL.test(v)) errors.push(`${where} must be an email address`);
      if (s.format === 'date-time' && (isNaN(Date.parse(v)) || !/^\d{4}-\d{2}-\d{2}T/.test(v))) errors.push(`${where} must be an ISO 8601 date-time`);
      return v;
    }
    case 'integer':
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || isNaN(n) || (s.type === 'integer' && !Number.isInteger(n))) {
        errors.push(`${where} must be ${s.type === 'integer' ? 'an integer' : 'a number'}`);
        return v;
      }
      if (s.minimum !== undefined && n < s.minimum) errors.push(`${where} must be >= ${s.minimum}`);
      if (s.maximum !== undefined && n > s.maximum) errors.push(`${where} must be <= ${s.maximum}`);
      return n;
    }
    case 'boolean':
      if (typeof v !== 'boolean') errors.push(`${where} must be a boolean`);
      return v;
    case 'array': {
      if (!Array.isArray(v)) {
        errors.push(`${where} must be an array`);
        return v;
      }
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${where} must have at most ${s.maxItems} items`);
      return s.items ? v.map((item, i) => check(s.items!, item, `${where}[${i}]`, errors)) : v;
    }
    default:
      return v;
  }
}
