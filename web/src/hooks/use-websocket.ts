import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionStatus, ServerMessage } from '@/types/chat'

/** 获取或生成持久化客户端 ID */
function getClientId(): string {
  let id = localStorage.getItem('sophon_client_id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('sophon_client_id', id)
  }
  return id
}

/**
 * 获取 WebSocket 连接地址
 *
 * 优先级：
 * 1. VITE_WS_URL 环境变量（构建时注入，用于生产环境独立部署）
 * 2. 当前页面同源地址
 */
function getWsUrl(): string {
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined
  if (envUrl) {
    return envUrl
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}`
}

interface UseWebSocketOptions {
  onMessage: (data: ServerMessage) => void
}

export function useWebSocket({ onMessage }: UseWebSocketOptions) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [disconnectReason, setDisconnectReason] = useState<string>('')
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  /** 标记是否已被清理，防止 StrictMode 双挂载导致的重连循环 */
  const disposedRef = useRef(false)

  const clientId = useRef(getClientId()).current

  const connect = useCallback(() => {
    // 清理旧的重连定时器
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }

    // 清理旧连接
    if (wsRef.current) {
      wsRef.current.onclose = null // 移除旧的 onclose 防止触发重连
      wsRef.current.onerror = null
      wsRef.current.onmessage = null
      wsRef.current.close()
      wsRef.current = null
    }

    setStatus('connecting')
    setDisconnectReason('')

    const wsUrl = getWsUrl()
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'identify', clientId }))
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ServerMessage

        // 收到服务端身份确认后标记为已连接
        if (data.type === 'connected') {
          setStatus('connected')
        }

        onMessageRef.current(data)
      } catch {
        // ignore parse errors
      }
    }

    ws.onclose = (event) => {
      // 如果这个 WebSocket 已经不是当前活跃的，忽略（被新连接替换了）
      if (wsRef.current !== ws) return

      setStatus('disconnected')
      wsRef.current = null

      if (event.code === 4003) {
        setDisconnectReason('已在其他标签页打开')
        return
      }

      // 已被清理（组件卸载）时不重连
      if (disposedRef.current) return

      // 自动重连
      reconnectTimer.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => {
      if (wsRef.current !== ws) return
      setStatus('error')
    }
  }, [clientId])

  const send = useCallback((text: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'message', text }))
    }
  }, [])

  useEffect(() => {
    disposedRef.current = false
    connect()

    return () => {
      disposedRef.current = true
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.onerror = null
        wsRef.current.onmessage = null
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [connect])

  return { status, disconnectReason, send }
}
