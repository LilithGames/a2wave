import { vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'

export function makeSelectChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(result),
            all: vi.fn().mockReturnValue(result ? [result] : []),
            orderBy: vi.fn().mockReturnValue(
              asyncQuery({
                all: vi.fn().mockReturnValue(result ? [result] : []),
              }),
            ),
          }),
        ),
        orderBy: vi.fn().mockReturnValue(
          asyncQuery({
            all: vi.fn().mockReturnValue(result ? [result] : []),
          }),
        ),
        all: vi.fn().mockReturnValue(result ? [result] : []),
      }),
    ),
  }
}

export function makeInsertChain(returnValue?: unknown) {
  return {
    values: vi.fn().mockReturnValue(
      asyncQuery({
        returning: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(returnValue ?? {}),
          }),
        ),
        run: vi.fn(),
      }),
    ),
  }
}

export function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            run: vi.fn().mockReturnValue({ changes: 1 }),
          }),
        ),
      }),
    ),
  }
}

export function makeUpdateReturningChain(returnValue?: unknown) {
  return {
    set: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            returning: vi.fn().mockReturnValue(
              asyncQuery({
                get: vi.fn().mockReturnValue(returnValue ?? {}),
              }),
            ),
            run: vi.fn(),
          }),
        ),
      }),
    ),
  }
}

export function makeDeleteChain() {
  return {
    where: vi.fn().mockReturnValue(
      asyncQuery({
        run: vi.fn(),
        returning: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(undefined),
          }),
        ),
      }),
    ),
  }
}
