/**
 * 客户端状态：一次 snapshot 拉齐三个子页与悬浮判定卡需要的一切
 * （世界书 + 其规则书 / 模组集 / 角色池 / 四元组进度 / 判定流水）。
 *
 * 页签或悬浮卡可见时轮询（8s），任何写入后立即刷新。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type SnapshotResponse } from './api.ts'

export interface ScorpioState {
  data: SnapshotResponse | undefined
  loading: boolean
  error: string | undefined
  setError: (message: string | undefined) => void
  refresh: () => Promise<void>
  afterWrite: () => Promise<void>
}

export function useScorpioState(sessionId: string | undefined, visible: boolean, intervalMs = 8000): ScorpioState {
  const [data, setData] = useState<SnapshotResponse | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const inFlight = useRef(false)
  const timer = useRef<number | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    if (sessionId === undefined || sessionId === '') return
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    try {
      setData(await api.snapshot(sessionId))
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!visible || sessionId === undefined || sessionId === '') return
    timer.current = window.setInterval(() => {
      void refresh()
    }, Math.max(3000, intervalMs))
    return () => {
      if (timer.current !== undefined) window.clearInterval(timer.current)
    }
  }, [visible, sessionId, intervalMs, refresh])

  useEffect(() => {
    if (visible) void refresh()
  }, [visible, refresh])

  return { data, loading, error, setError, refresh, afterWrite: refresh }
}
