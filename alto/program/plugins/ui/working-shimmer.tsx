import { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

export const WorkingShimmerContext = createContext(false)

export function WorkingShimmer({
  active,
  className,
  children,
}: {
  active?: boolean
  className: string
  children: ReactNode
}): ReactNode {
  const inherited = useContext(WorkingShimmerContext)
  const enabled = active ?? inherited
  const root = useRef<HTMLSpanElement>(null)
  const sweep = useRef<HTMLSpanElement>(null)
  const highlight = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    if (!enabled || !root.current || !highlight.current) return
    // Copy the rendered inline content, not its React components: Markdown
    // links and plugin renderers must only mount once. The copy is inert and
    // excluded from selection and accessibility; IDs belong to the original.
    const copies = Array.from(root.current.childNodes)
      .filter((node) => node !== sweep.current)
      .map((node) => node.cloneNode(true))
    highlight.current.replaceChildren(...copies)
    for (const node of highlight.current.querySelectorAll('[id]')) node.removeAttribute('id')
  }, [children, enabled])

  useEffect(() => {
    const element = root.current
    if (!enabled || !element) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let timer: number | undefined
    const stop = (): void => {
      window.clearTimeout(timer)
      timer = undefined
      element.classList.remove('is-shimmer-sweeping')
    }
    const animate = (): void => {
      element.classList.add('is-shimmer-sweeping')
      timer = window.setTimeout(() => {
        element.classList.remove('is-shimmer-sweeping')
        timer = window.setTimeout(animate, 3_000)
      }, 1_000)
    }
    const restart = (): void => {
      stop()
      if (!reducedMotion.matches) timer = window.setTimeout(animate, 600)
    }
    restart()
    reducedMotion.addEventListener('change', restart)
    return () => {
      stop()
      reducedMotion.removeEventListener('change', restart)
    }
  }, [enabled])

  return (
    <span ref={root} className={`${className}${enabled ? ' activity-working-shimmer' : ''}`}>
      {children}
      {enabled && (
        <span ref={sweep} className="activity-shimmer-sweep" aria-hidden="true" inert>
          <span ref={highlight} className="activity-shimmer-highlight" />
        </span>
      )}
    </span>
  )
}
