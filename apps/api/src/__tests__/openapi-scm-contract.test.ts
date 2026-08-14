import { describe, expect, it } from 'vitest'
import { openApiSpec } from '../openapi.js'

describe('SCM OpenAPI contract', () => {
  type ScmInputBranch = {
    required?: string[]
    properties?: Record<string, { enum?: string[]; required?: string[] } | undefined>
  }

  it('publishes create and stateless probe paths', () => {
    expect(openApiSpec.paths).toHaveProperty('/scm-sources')
    expect(openApiSpec.paths).toHaveProperty('/scm-sources/probe')
    expect(openApiSpec.paths['/scm-sources']?.post?.security).toEqual([{ userSession: [] }])
    expect(openApiSpec.paths['/scm-sources/probe']?.post?.security).toEqual([{ userSession: [] }])
  })

  it('publishes every SCM operation changed by the managed-storage lifecycle', () => {
    const operations = [
      ['/scm-sources', 'get'],
      ['/scm-sources/{id}', 'get'],
      ['/scm-sources/{id}', 'patch'],
      ['/scm-sources/{id}', 'delete'],
      ['/scm-sources/{id}/sync', 'post'],
      ['/scm-sources/{id}/check', 'post'],
      ['/scm-sources/{id}/status', 'get'],
      ['/scm-sources/{id}/codegraph/reindex', 'post'],
      ['/scm-sources/{id}/workspaces', 'get'],
      ['/scm-sources/{id}/workspaces/{name}', 'delete'],
    ] as const

    for (const [path, method] of operations) {
      expect(openApiSpec.paths[path]?.[method], `${method.toUpperCase()} ${path}`).toBeDefined()
      expect(openApiSpec.paths[path]?.[method]?.security).toEqual([{ userSession: [] }])
    }
    expect(openApiSpec.paths['/scm-sources']?.post?.responses).toHaveProperty('201')
    expect(openApiSpec.paths['/scm-sources/{id}/sync']?.post?.responses).toHaveProperty('202')
    expect(
      openApiSpec.paths['/scm-sources/{id}/codegraph/reindex']?.post?.responses,
    ).toHaveProperty('202')
    expect(openApiSpec.paths['/scm-sources/{id}']?.delete?.responses).toHaveProperty('503')
  })

  it('documents managed Git create separately from P4 path requirements', () => {
    const create = openApiSpec.components?.schemas?.CreateScmSourceRequest as {
      oneOf?: ScmInputBranch[]
    }
    expect(create.oneOf).toHaveLength(2)
    const git = create.oneOf?.find((branch) => !branch.required?.includes('localPath'))
    const p4 = create.oneOf?.find((branch) => branch.required?.includes('localPath'))
    expect(git?.properties?.type).toEqual({ type: 'string', enum: ['git'] })
    expect(p4?.properties?.type).toEqual({ type: 'string', enum: ['p4'] })
    expect(git?.properties?.config?.required).toEqual(['type', 'repoUrl'])
    expect(p4?.properties?.config?.required).toEqual(['type', 'p4port', 'p4user', 'p4client'])
  })

  it('documents that P4 probe requires localPath while Git probe does not', () => {
    const probe = openApiSpec.components?.schemas?.ProbeScmSourceRequest as {
      oneOf?: ScmInputBranch[]
    }
    const git = probe.oneOf?.find((branch) => !branch.required?.includes('localPath'))
    const p4 = probe.oneOf?.find((branch) => branch.required?.includes('localPath'))
    expect(git?.properties?.type).toEqual({ type: 'string', enum: ['git'] })
    expect(p4?.properties?.type).toEqual({ type: 'string', enum: ['p4'] })
    expect(git?.properties?.config?.required).toEqual(['type', 'repoUrl'])
    expect(p4?.properties?.config?.required).toEqual(['type', 'p4port', 'p4user', 'p4client'])

    const response = openApiSpec.components?.schemas?.ScmProbeResponse as {
      properties?: { data?: { properties?: Record<string, unknown> } }
    }
    expect(response.properties?.data?.properties).toHaveProperty('clientRoot')
    expect(response.properties?.data?.properties).toHaveProperty('clientRootWarning')
    expect(
      (
        openApiSpec.paths['/scm-sources/probe']?.post?.responses['200'] as {
          content?: { 'application/json'?: { schema?: { $ref?: string } } }
        }
      ).content?.['application/json']?.schema?.$ref,
    ).toBe('#/components/schemas/ScmProbeResponse')
  })
})
