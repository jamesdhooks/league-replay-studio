import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Shared timeline viewport/range synchronization.
 * Keeps range slider, scroll position, and content width in lockstep.
 */
export function useTimelineViewport({
  totalDuration,
  fallbackWidth = 800,
  minRangeWidth = 0.02,
  measureKey = null,
}) {
  const containerRef = useRef(null)
  const scrollRef = useRef(null)
  const syncingRef = useRef(false)

  const [rangeStart, setRangeStart] = useState(0)
  const [rangeEnd, setRangeEnd] = useState(1)
  const [containerWidth, setContainerWidth] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)

  const rangeWidth = Math.max(minRangeWidth, rangeEnd - rangeStart)
  const baseContentWidth = containerWidth > 0 ? containerWidth : fallbackWidth
  const contentWidth = baseContentWidth / rangeWidth
  const pxPerUnit = totalDuration > 0 ? contentWidth / totalDuration : 0

  const toX = useCallback((value) => value * pxPerUnit, [pxPerUnit])

  const setRange = useCallback((start, end) => {
    setRangeStart(start)
    setRangeEnd(end)
  }, [])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined

    const measure = () => {
      setContainerWidth(element.clientWidth)
      setContainerHeight(element.clientHeight)
    }

    measure()

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
        setContainerHeight(entry.contentRect.height)
      }
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [measureKey])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || contentWidth <= 0) return
    const target = Math.round(rangeStart * contentWidth)
    if (Math.abs(element.scrollLeft - target) < 1) return
    syncingRef.current = true
    element.scrollLeft = target
  }, [rangeStart, contentWidth])

  const handleTimelineScroll = useCallback(() => {
    if (syncingRef.current) {
      syncingRef.current = false
      return
    }
    const element = scrollRef.current
    if (!element || contentWidth <= 0) return
    const width = rangeEnd - rangeStart
    const nextStart = Math.max(0, Math.min(1 - width, element.scrollLeft / contentWidth))
    setRangeStart(nextStart)
    setRangeEnd(nextStart + width)
  }, [contentWidth, rangeEnd, rangeStart])

  return {
    containerRef,
    scrollRef,
    rangeStart,
    rangeEnd,
    setRange,
    setRangeStart,
    setRangeEnd,
    containerWidth,
    containerHeight,
    contentWidth,
    pxPerUnit,
    toX,
    handleTimelineScroll,
  }
}
