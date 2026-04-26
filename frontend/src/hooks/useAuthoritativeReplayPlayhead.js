import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGet, apiPost } from '../services/api'
import { useLocalStorage } from './useLocalStorage'

function clampTime(value, duration) {
  const safeValue = Number.isFinite(value) ? value : 0
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, safeValue)
  return Math.max(0, Math.min(duration, safeValue))
}

function computeClockLocalTime(clock, wallNow = performance.now()) {
  if (!clock) return null
  if (clock.paused) return clock.pauseLocalTime
  return clock.startLocalTime + ((wallNow - clock.startWallMs - clock.accPausedMs) / 1000) * clock.speed
}

export function useAuthoritativeReplayPlayhead({
  isConnected,
  raceSessionNum,
  getSessionNumForLocalTime,
  localDuration,
  storageKey = 'lrs:replay:timeline:speed',
  defaultSpeed = 1,
  getSessionTimeForLocalTime,
  getLocalTimeForSessionTime,
  fallbackLocalTime = 0,
  driftThresholdSeconds = 2,
  driftCooldownMs = 3000,
  pollIntervalMs = 350,
  tickIntervalMs = 50,
}) {
  const [replaySpeed, setReplaySpeed] = useLocalStorage(storageKey, defaultSpeed)
  const [replayState, setReplayState] = useState(null)
  const [driftSeconds, setDriftSeconds] = useState(null)
  const [optimisticLocalTime, setOptimisticLocalTime] = useState(null)
  const [clockLocalTime, setClockLocalTime] = useState(null)
  const [interpolatedLocalTime, setInterpolatedLocalTime] = useState(null)
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false)
  const [clockVersion, setClockVersion] = useState(0)

  const replayStateRef = useRef(null)
  const replayAnchorRef = useRef(null)
  const clockRef = useRef(null)
  const getSessionTimeRef = useRef(getSessionTimeForLocalTime)
  const getLocalTimeRef = useRef(getLocalTimeForSessionTime)

  useEffect(() => {
    getSessionTimeRef.current = getSessionTimeForLocalTime
  }, [getSessionTimeForLocalTime])

  useEffect(() => {
    getLocalTimeRef.current = getLocalTimeForSessionTime
  }, [getLocalTimeForSessionTime])

  const getSessionNumForLocalTimeRef = useRef(getSessionNumForLocalTime)

  useEffect(() => {
    getSessionNumForLocalTimeRef.current = getSessionNumForLocalTime
  }, [getSessionNumForLocalTime])

  useEffect(() => {
    if (!isConnected) {
      setReplayState(null)
      replayStateRef.current = null
      return undefined
    }

    const pollReplayState = () => {
      apiGet('/iracing/replay/state')
        .then((data) => {
          const next = data || null
          setReplayState(next)
          replayStateRef.current = next
        })
        .catch(() => {})
    }

    pollReplayState()
    const interval = setInterval(pollReplayState, pollIntervalMs)
    return () => clearInterval(interval)
  }, [isConnected, pollIntervalMs])

  useEffect(() => {
    if (!replayState) {
      replayAnchorRef.current = null
      setInterpolatedLocalTime(null)
      return
    }

    const mappedLocal = getLocalTimeRef.current?.(replayState.session_time, replayState)
    if (!Number.isFinite(mappedLocal)) {
      replayAnchorRef.current = null
      setInterpolatedLocalTime(null)
      return
    }

    const speed = Number(replayState.replay_speed)
    replayAnchorRef.current = {
      localTime: clampTime(mappedLocal, localDuration),
      wallMs: performance.now(),
      speed: Number.isFinite(speed) ? speed : 0,
    }
    setInterpolatedLocalTime(clampTime(mappedLocal, localDuration))
  }, [localDuration, replayState])

  useEffect(() => {
    const interval = setInterval(() => {
      if (optimisticLocalTime != null || clockLocalTime != null) return
      const anchor = replayAnchorRef.current
      if (!anchor) return

      if (!Number.isFinite(anchor.speed) || anchor.speed === 0) {
        setInterpolatedLocalTime(anchor.localTime)
        return
      }

      const elapsedSeconds = (performance.now() - anchor.wallMs) / 1000
      const next = clampTime(anchor.localTime + (elapsedSeconds * anchor.speed), localDuration)
      setInterpolatedLocalTime(next)
    }, tickIntervalMs)

    return () => clearInterval(interval)
  }, [clockLocalTime, localDuration, optimisticLocalTime, tickIntervalMs])

  const resolveSessionNum = useCallback((sessionTime, localTimeHint = null) => {
    if (Number.isFinite(localTimeHint) && typeof getSessionNumForLocalTimeRef.current === 'function') {
      const dynamicSession = getSessionNumForLocalTimeRef.current(localTimeHint, sessionTime)
      if (Number.isFinite(dynamicSession) && dynamicSession >= 0) return Math.trunc(dynamicSession)
    }
    if (raceSessionNum == null) return null
    return raceSessionNum
  }, [raceSessionNum])

  const seekToSessionTime = useCallback((sessionTime, localTimeHint = null) => {
    const sessionNum = resolveSessionNum(sessionTime, localTimeHint)
    if (!isConnected || sessionNum == null || !Number.isFinite(sessionTime)) return Promise.resolve(null)
    return apiPost('/iracing/replay/seek-time', {
      session_num: sessionNum,
      session_time_ms: Math.round(Math.max(0, sessionTime) * 1000),
      resolve_session: false,
    }).catch(() => null)
  }, [isConnected, resolveSessionNum])

  const seekToLocalTime = useCallback((localTime) => {
    const sessionTime = getSessionTimeRef.current?.(localTime)
    if (!Number.isFinite(sessionTime)) return Promise.resolve(null)
    return seekToSessionTime(sessionTime, localTime)
  }, [seekToSessionTime])

  const playReplay = useCallback(async () => {
    if (!isConnected) return null
    return apiPost('/iracing/replay/play').catch(() => null)
  }, [isConnected])

  const pauseReplay = useCallback(async () => {
    if (!isConnected) return null
    return apiPost('/iracing/replay/pause').catch(() => null)
  }, [isConnected])

  const syncReplaySpeed = useCallback(async (speed) => {
    setReplaySpeed(speed)
    if (!isConnected) return null
    return apiPost('/iracing/replay/speed', { speed }).catch(() => null)
  }, [isConnected, setReplaySpeed])

  const toggleReplayPlayPause = useCallback(async (playing, speed = replaySpeed || 1) => {
    if (!isConnected) return null
    if (playing) {
      return apiPost('/iracing/replay/speed', { speed: 0 }).catch(() => null)
    }
    return apiPost('/iracing/replay/speed', { speed }).catch(() => null)
  }, [isConnected, replaySpeed])

  const startClock = useCallback(({
    startLocalTime = 0,
    speed = replaySpeed || 1,
    getExpectedSessionTime = null,
    getExpectedState = null,
  } = {}) => {
    const clampedStart = clampTime(startLocalTime, localDuration)
    clockRef.current = {
      startWallMs: performance.now(),
      startLocalTime: clampedStart,
      speed,
      accPausedMs: 0,
      paused: false,
      pauseWallMs: 0,
      pauseLocalTime: clampedStart,
      userScrubbing: false,
      lastSeekMs: 0,
      lastPlayMs: 0,
      lastPauseMs: 0,
      lastSpeedMs: 0,
      lastCamMs: 0,
      getExpectedSessionTime,
      getExpectedState,
      expectedCamGroupNum: null,
      expectedCarIdx: null,
    }
    setClockLocalTime(clampedStart)
    setDriftSeconds(null)
    setClockVersion(v => v + 1)
  }, [localDuration, replaySpeed])

  const stopClock = useCallback(() => {
    clockRef.current = null
    setClockLocalTime(null)
    setDriftSeconds(null)
    setOptimisticLocalTime(null)
    setIsDraggingPlayhead(false)
    setClockVersion(v => v + 1)
  }, [])

  const pauseClock = useCallback(() => {
    const clock = clockRef.current
    if (!clock || clock.paused) return
    clock.pauseWallMs = performance.now()
    clock.pauseLocalTime = computeClockLocalTime(clock, clock.pauseWallMs)
    clock.paused = true
    setClockLocalTime(clampTime(clock.pauseLocalTime, localDuration))
  }, [localDuration])

  const resumeClock = useCallback(() => {
    const clock = clockRef.current
    if (!clock || !clock.paused) return
    clock.accPausedMs += performance.now() - clock.pauseWallMs
    clock.paused = false
  }, [])

  const reanchorClock = useCallback((localTime) => {
    const clock = clockRef.current
    if (!clock) return
    const clampedLocalTime = clampTime(localTime, localDuration)
    clock.startWallMs = performance.now()
    clock.startLocalTime = clampedLocalTime
    clock.accPausedMs = 0
    clock.pauseLocalTime = clampedLocalTime
    setClockLocalTime(clampedLocalTime)
  }, [localDuration])

  const setClockUserScrubbing = useCallback((userScrubbing) => {
    const clock = clockRef.current
    if (!clock) return
    clock.userScrubbing = userScrubbing
  }, [])

  useEffect(() => {
    const clock = clockRef.current
    if (!clock) return undefined

    const interval = setInterval(() => {
      const currentClock = clockRef.current
      if (!currentClock) return

      const wallNow = performance.now()
      const nextLocalTime = clampTime(computeClockLocalTime(currentClock, wallNow), localDuration)

      if (!currentClock.userScrubbing) {
        setClockLocalTime(nextLocalTime)
      }

      if (currentClock.paused) {
        // Keep iRacing aligned with the paused local timeline; if transport drifts
        // into play, force it back to pause instead of allowing silent desync.
        if (
          replayStateRef.current?.replay_speed !== 0
          && wallNow - (currentClock.lastPauseMs || 0) > 600
        ) {
          currentClock.lastPauseMs = wallNow
          pauseReplay()
        }
        return
      }

      const expectedSessionTime = typeof currentClock.getExpectedSessionTime === 'function'
        ? currentClock.getExpectedSessionTime({
          wallNow,
          localTime: nextLocalTime,
          clock: currentClock,
          replayState: replayStateRef.current,
        })
        : getSessionTimeRef.current?.(nextLocalTime)

      const actualSessionTime = replayStateRef.current?.session_time
      if (Number.isFinite(expectedSessionTime) && Number.isFinite(actualSessionTime)) {
        const drift = actualSessionTime - expectedSessionTime
        setDriftSeconds(drift)
        if (
          Math.abs(drift) > driftThresholdSeconds
          && wallNow - (currentClock.lastSeekMs || 0) > driftCooldownMs
        ) {
          currentClock.lastSeekMs = wallNow
          seekToSessionTime(expectedSessionTime, nextLocalTime)
        }
      } else {
        setDriftSeconds(null)
      }

      const expectedState = typeof currentClock.getExpectedState === 'function'
        ? currentClock.getExpectedState({
          wallNow,
          localTime: nextLocalTime,
          clock: currentClock,
          replayState: replayStateRef.current,
        })
        : null

      if (!expectedState || !replayStateRef.current) return

      if (expectedState.speed != null) {
        const desiredSpeed = Math.max(1, Math.round(expectedState.speed))
        if (replayStateRef.current.replay_speed === 0 && wallNow - (currentClock.lastSpeedMs || 0) > 2000) {
          currentClock.lastSpeedMs = wallNow
          apiPost('/iracing/replay/speed', { speed: desiredSpeed }).catch(() => {})
        }
        if (
          replayStateRef.current.replay_speed !== 0
          && replayStateRef.current.replay_speed !== desiredSpeed
          && wallNow - (currentClock.lastSpeedMs || 0) > 2000
        ) {
          currentClock.lastSpeedMs = wallNow
          apiPost('/iracing/replay/speed', { speed: desiredSpeed }).catch(() => {})
        }
      }

      if (expectedState.camGroupNum != null) {
        const camMismatch = replayStateRef.current.cam_group_num !== expectedState.camGroupNum
          || (expectedState.carIdx != null && replayStateRef.current.cam_car_idx !== expectedState.carIdx)
        if (camMismatch && wallNow - (currentClock.lastCamMs || 0) > 1500) {
          currentClock.lastCamMs = wallNow
          apiPost('/iracing/replay/camera', {
            group_num: expectedState.camGroupNum,
            ...(expectedState.carIdx != null ? { car_idx: expectedState.carIdx } : { position: 1 }),
          }).catch(() => {})
        }
      }
    }, tickIntervalMs)

    return () => clearInterval(interval)
  }, [
    clockVersion,
    driftCooldownMs,
    driftThresholdSeconds,
    localDuration,
    pauseReplay,
    seekToSessionTime,
    tickIntervalMs,
  ])

  const fallbackValue = typeof fallbackLocalTime === 'function' ? fallbackLocalTime() : fallbackLocalTime

  const displayLocalTime = useMemo(() => {
    if (optimisticLocalTime != null) return clampTime(optimisticLocalTime, localDuration)
    if (clockLocalTime != null) return clampTime(clockLocalTime, localDuration)
    if (interpolatedLocalTime != null) return clampTime(interpolatedLocalTime, localDuration)
    if (replayState?.session_time != null) {
      const mapped = getLocalTimeRef.current?.(replayState.session_time, replayState)
      if (mapped != null) return clampTime(mapped, localDuration)
    }
    return clampTime(fallbackValue, localDuration)
  }, [clockLocalTime, fallbackValue, interpolatedLocalTime, localDuration, optimisticLocalTime, replayState])

  return {
    replaySpeed,
    setReplaySpeed,
    replayState,
    replayStateRef,
    driftSeconds,
    optimisticLocalTime,
    setOptimisticLocalTime,
    clockLocalTime,
    displayLocalTime,
    isDraggingPlayhead,
    setIsDraggingPlayhead,
    clockRef,
    seekToSessionTime,
    seekToLocalTime,
    playReplay,
    pauseReplay,
    syncReplaySpeed,
    toggleReplayPlayPause,
    startClock,
    stopClock,
    pauseClock,
    resumeClock,
    reanchorClock,
    setClockUserScrubbing,
  }
}
