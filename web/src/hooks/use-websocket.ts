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
 * 2. 当前页面同源地址（开发时由 Vite proxy 代理）
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

  const clientId = useRef(getClientId()).current

  const connect = useCallback(() => {
    // 清理旧连接
    if (wsRef.current) {
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
        onMessageRef.current(data)
      } catch {
        // ignore parse errors
      }
    }

    ws.onclose = (event) => {
      setStatus('disconnected')
      wsRef.current = null

      if (event.code === 4003) {
        setDisconnectReason('已在其他标签页打开')
        return
      }

      // 自动重连
      reconnectTimer.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => {
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
    connect()
    return () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [connect])

  return { status, disconnectReason, send }
}
