/** Converts an MCP tool's JSON Schema into a zod schema the AI SDK can validate arguments against. */
import { z } from 'zod'

export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.any()
  const s = schema as Record<string, unknown>

  if (Array.isArray(s.enum)) {
    const values = s.enum.filter((v): v is string => typeof v === 'string')
    if (values.length > 0) return z.enum([values[0]!, ...values.slice(1)])
  }

  const union = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null
  if (union) {
    const branches = union.map(jsonSchemaToZod)
    const nonNull = branches.filter((b) => !(b instanceof z.ZodNull))
    const nullable = branches.length !== nonNull.length
    const resolved = nonNull.length === 1 ? nonNull[0]! : z.union([nonNull[0]!, nonNull[1]!, ...nonNull.slice(2)])
    return nullable ? resolved.nullable() : resolved
  }

  switch (s.type) {
    case 'string': {
      let out = z.string()
      if (typeof s.minLength === 'number') out = out.min(s.minLength)
      if (typeof s.maxLength === 'number') out = out.max(s.maxLength)
      if (typeof s.pattern === 'string') {
        try {
          out = out.regex(new RegExp(s.pattern))
        } catch {
          // A server's broken pattern shouldn't break the whole tool.
        }
      }
      return out
    }
    case 'number':
    case 'integer': {
      let out = z.number()
      if (typeof s.minimum === 'number') out = out.min(s.minimum)
      if (typeof s.maximum === 'number') out = out.max(s.maximum)
      return s.type === 'integer' ? out.int() : out
    }
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    case 'array':
      return z.array(s.items ? jsonSchemaToZod(s.items) : z.any())
    case 'object': {
      const properties = (s.properties && typeof s.properties === 'object' ? s.properties : {}) as Record<string, unknown>
      const required = new Set(Array.isArray(s.required) ? s.required.filter((k): k is string => typeof k === 'string') : [])
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [key, value] of Object.entries(properties)) {
        const field = jsonSchemaToZod(value)
        shape[key] = required.has(key) ? field : field.optional()
      }
      // Loose (not strict): never strip arguments a server declares nowhere — servers are sloppy.
      return z.looseObject(shape)
    }
    default:
      return z.any()
  }
}
