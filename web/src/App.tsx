import { useChat } from '@/hooks/use-chat'
import { ChatHeader } from '@/components/chat/chat-header'
import { MessageList } from '@/components/chat/message-list'
import { ChatInput } from '@/components/chat/chat-input'

export default function App() {
  const {
    messages,
    progressSteps,
    isWaiting,
    showWelcome,
    status,
    disconnectReason,
    sendMessage,
  } = useChat()

  return (
    <div className="flex flex-col h-screen bg-background">
      <ChatHeader
        status={status}
        disconnectReason={disconnectReason}
        onCommand={sendMessage}
      />

      <MessageList
        messages={messages}
        progressSteps={progressSteps}
        isWaiting={isWaiting}
        showWelcome={showWelcome}
        onQuickMessage={sendMessage}
      />

      <ChatInput
        onSend={sendMessage}
        disabled={isWaiting}
        status={status}
      />
    </div>
  )
}
