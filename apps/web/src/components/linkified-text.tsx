import { Fragment } from 'react'
import { cn } from '@/lib/utils'

// CJK punctuation and quotes are excluded so pasted Chinese prose doesn't swallow them into the href.
const URL_PATTERN = /https?:\/\/[^\s<>"'`，。；：！？、）】》」』]+/g
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/

function trimTrailing(url: string): string {
  const trimmed = url.replace(TRAILING_PUNCTUATION, '')
  return trimmed || url
}

/** Renders text with bare http(s) URLs turned into clickable links. */
export function LinkifiedText({ text, className }: { text: string; className?: string }) {
  const nodes: React.ReactNode[] = []
  let lastIndex = 0

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    const url = trimTrailing(match[0])
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start))
    nodes.push(
      <a
        key={`${start}-${url}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 break-all hover:opacity-80"
      >
        {url}
      </a>,
    )
    lastIndex = start + url.length
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))

  return (
    <span className={cn('whitespace-pre-wrap break-words', className)}>
      {nodes.map((node, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
        <Fragment key={i}>{node}</Fragment>
      ))}
    </span>
  )
}
