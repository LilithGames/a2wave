import { getTableName } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import { a2aTasks, runSteps, runs } from '../../db/schema.sqlite.js'

describe('alias probe', () => {
  it('reports original name', () => {
    const a = alias(a2aTasks, 'task_alias')
    console.log('getTableName(alias)=', getTableName(a))
    console.log(
      'OriginalName on table=',
      (a as unknown as Record<symbol, unknown>)[Symbol.for('drizzle:OriginalName')],
    )
    console.log(
      'OriginalName on col.table=',
      (a.data.table as unknown as Record<symbol, unknown>)[Symbol.for('drizzle:OriginalName')],
    )
    console.log(
      'non-alias a2aTasks OriginalName=',
      (a2aTasks as unknown as Record<symbol, unknown>)[Symbol.for('drizzle:OriginalName')],
    )
    console.log('runs.result dataType=', runs.result.dataType, 'name=', runs.result.name)
    console.log('a2aTasks.data dataType=', a2aTasks.data.dataType, 'name=', a2aTasks.data.name)
    console.log('runSteps.output dataType=', runSteps.output.dataType)
    console.log('syms=', Object.getOwnPropertySymbols(a).map(String))
    expect(1).toBe(1)
  })
})
