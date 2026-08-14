/// <reference types="vitest/globals" />
import '@testing-library/jest-dom/vitest'

// ---- Global DOM API mocks ----
// These APIs are not available in jsdom but are used by Ant Design / TailwindCSS / components.

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// antd >= 6.6 styles borderless Inputs with `&:has(input:focus-visible)`. CSS-in-JS
// expands `&` to the enclosing selector chain, so inside a Tailwind-classed container
// the rule reaching jsdom carries an unescaped arbitrary-value class such as
// `min-h-[7.5rem]`. nwsapi cannot parse it, and because its `:has()` resolver
// re-enters `querySelector` while matching, the throw escapes jsdom's own
// `matchesDontThrow` guard — failing any test that computes a role or visibility
// inside such a container. Real browsers parse the rule fine; this is purely a jsdom
// limitation, so restore the "unmatchable selector simply does not match" behavior
// that `matchesDontThrow` already intends.
//
// jsdom throws a DOMException, which is not an `instanceof Error`. The re-entrant call
// always arrives as `:scope <inner>`, so only that shape is swallowed — a malformed
// selector written by application code still surfaces as it should.
const isReentrantSelectorError = (error: unknown, selectors: string) =>
  (error as { name?: string })?.name === 'SyntaxError' && selectors.startsWith(':scope ')

const originalQuerySelector = Element.prototype.querySelector
Element.prototype.querySelector = function patched(this: Element, selectors: string) {
  try {
    return originalQuerySelector.call(this, selectors)
  } catch (error) {
    if (isReentrantSelectorError(error, selectors)) return null
    throw error
  }
}

const originalQuerySelectorAll = Element.prototype.querySelectorAll
Element.prototype.querySelectorAll = function patched(this: Element, selectors: string) {
  try {
    return originalQuerySelectorAll.call(this, selectors)
  } catch (error) {
    if (isReentrantSelectorError(error, selectors)) {
      // An empty NodeList: the fragment holds no children, so nothing can match.
      return document.createDocumentFragment().childNodes as NodeListOf<Element>
    }
    throw error
  }
}

// jsdom logs a noisy "not implemented" error whenever a library requests a
// pseudo-element style. Ant Design only uses the result to measure scrollbar
// chrome, so falling back to the element style is the closest useful behavior.
const getComputedStyle = window.getComputedStyle.bind(window)
Object.defineProperty(window, 'getComputedStyle', {
  configurable: true,
  value: (element: Element) => getComputedStyle(element),
})

class MockResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

class MockIntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: readonly number[] = []
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  takeRecords = vi.fn().mockReturnValue([])
}
globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver

// jsdom does not implement scrollIntoView; the chat transcript calls it on every
// message change, so any test rendering a non-empty conversation would throw.
Element.prototype.scrollIntoView = vi.fn()

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value))
    }),
  }
}

if (
  typeof globalThis.localStorage === 'undefined' ||
  typeof globalThis.localStorage.getItem !== 'function'
) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: createMemoryStorage(),
  })
}

// Suppress known React act() warnings in test output.
// Matches only the exact React warning patterns to avoid swallowing real errors.
const SUPPRESSED_PATTERNS = [
  /^An update to .+ inside a test was not wrapped in act/,
  /^Warning:.*ReactDOMTestUtils\.act/,
]
const originalError = console.error
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    const msg = typeof args[0] === 'string' ? args[0] : ''
    if (SUPPRESSED_PATTERNS.some((re) => re.test(msg))) return
    originalError.call(console, ...args)
  }
})
afterAll(() => {
  console.error = originalError
})

// 测试间隔离 localStorage：草稿等持久化逻辑会写入 localStorage，避免跨用例泄漏。
afterEach(() => {
  try {
    localStorage.clear()
  } catch {
    // ignore
  }
})
