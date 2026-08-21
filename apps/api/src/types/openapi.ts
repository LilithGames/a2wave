/**
 * Minimal OpenAPI 3.0 type definitions.
 * Avoids pulling in the full `openapi-types` package.
 */
export namespace OpenAPIV3 {
  export interface Document {
    openapi: string
    info: InfoObject
    servers?: ServerObject[]
    paths: Record<string, PathItemObject>
    components?: ComponentsObject
    security?: SecurityRequirementObject[]
  }

  export interface InfoObject {
    title: string
    version: string
    description?: string
  }

  export interface ServerObject {
    url: string
    description?: string
  }

  export interface ComponentsObject {
    schemas?: Record<string, SchemaObject>
    securitySchemes?: Record<string, SecuritySchemeObject>
    parameters?: Record<string, ParameterObject>
  }

  export interface SecuritySchemeObject {
    type: string
    scheme?: string
    in?: string
    name?: string
    description?: string
    bearerFormat?: string
  }

  export interface SecurityRequirementObject {
    [name: string]: string[]
  }

  export interface ParameterObject {
    name: string
    in: string
    required?: boolean
    schema?: SchemaObject
    description?: string
  }

  export interface PathItemObject {
    get?: OperationObject
    post?: OperationObject
    put?: OperationObject
    delete?: OperationObject
    patch?: OperationObject
  }

  export interface OperationObject {
    operationId?: string
    summary?: string
    description?: string
    tags?: string[]
    parameters?: (ParameterObject | ReferenceObject)[]
    requestBody?: RequestBodyObject
    responses: Record<string, ResponseObject | ReferenceObject>
    security?: SecurityRequirementObject[]
  }

  export interface RequestBodyObject {
    required?: boolean
    content: Record<string, MediaTypeObject>
  }

  export interface MediaTypeObject {
    schema?: SchemaObject | ReferenceObject
    examples?: Record<string, ExampleObject>
  }

  export interface ExampleObject {
    summary?: string
    value?: unknown
  }

  export interface ResponseObject {
    description: string
    headers?: Record<string, { schema?: SchemaObject; description?: string }>
    content?: Record<string, MediaTypeObject>
  }

  export interface ReferenceObject {
    $ref: string
  }

  export interface SchemaObject {
    type?: string
    format?: string
    oneOf?: (SchemaObject | ReferenceObject)[]
    properties?: Record<string, SchemaObject | ReferenceObject>
    required?: string[]
    items?: SchemaObject | ReferenceObject
    additionalProperties?: boolean | SchemaObject | ReferenceObject
    enum?: unknown[]
    default?: unknown
    nullable?: boolean
    description?: string
    minLength?: number
    maxLength?: number
    pattern?: string
    $ref?: string
  }
}
