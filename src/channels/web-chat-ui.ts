/**
 * Web 聊天 UI
 * 
 * 内嵌的 HTML/CSS/JS 聊天界面，无需额外静态文件。
 * 现代化设计，支持 Markdown 渲染和暗色主题。
 */

export function getChatPageHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sophon AI 助手</title>
  <style>
    :root {
      --bg-primary: #0f0f0f;
      --bg-secondary: #1a1a1a;
      --bg-tertiary: #242424;
      --bg-input: #1e1e1e;
      --text-primary: #e4e4e7;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --accent: #6366f1;
      --accent-hover: #818cf8;
      --border: #2e2e2e;
      --user-bubble: #2563eb;
      --assistant-bubble: #262626;
      --success: #22c55e;
      --shadow: 0 1px 3px rgba(0,0,0,0.3);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* 顶栏 */
    .header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 14px 20px;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }

    .header-logo {
      font-size: 24px;
    }

    .header-title {
      font-size: 16px;
      font-weight: 600;
    }

    .header-status {
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-muted);
      transition: background 0.3s;
    }

    .status-dot.connected {
      background: var(--success);
    }

    /* 消息区域 */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      scroll-behavior: smooth;
    }

    .messages::-webkit-scrollbar {
      width: 6px;
    }

    .messages::-webkit-scrollbar-track {
      background: transparent;
    }

    .messages::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 3px;
    }

    /* 消息气泡 */
    .message {
      display: flex;
      gap: 12px;
      max-width: 80%;
      animation: fadeIn 0.2s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message.user {
      align-self: flex-end;
      flex-direction: row-reverse;
    }

    .message.assistant {
      align-self: flex-start;
    }

    .message-avatar {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
      background: var(--bg-tertiary);
    }

    .message.user .message-avatar {
      background: var(--user-bubble);
    }

    .message-content {
      padding: 10px 14px;
      border-radius: 12px;
      line-height: 1.6;
      font-size: 14px;
      word-break: break-word;
    }

    .message.user .message-content {
      background: var(--user-bubble);
      color: #fff;
      border-bottom-right-radius: 4px;
    }

    .message.assistant .message-content {
      background: var(--assistant-bubble);
      border: 1px solid var(--border);
      border-bottom-left-radius: 4px;
    }

    .message-content pre {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      margin: 8px 0;
      overflow-x: auto;
      font-size: 13px;
    }

    .message-content code {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 13px;
    }

    .message-content p {
      margin: 4px 0;
    }

    .message-content p:first-child {
      margin-top: 0;
    }

    .message-content p:last-child {
      margin-bottom: 0;
    }

    /* 正在输入指示器 */
    .typing-indicator {
      display: none;
      align-self: flex-start;
      gap: 12px;
      max-width: 80%;
      animation: fadeIn 0.2s ease-out;
    }

    .typing-indicator.visible {
      display: flex;
    }

    .typing-dots {
      padding: 14px 18px;
      background: var(--assistant-bubble);
      border: 1px solid var(--border);
      border-radius: 12px;
      border-bottom-left-radius: 4px;
      display: flex;
      gap: 4px;
      align-items: center;
    }

    .typing-dots span {
      width: 6px;
      height: 6px;
      background: var(--text-muted);
      border-radius: 50%;
      animation: bounce 1.4s infinite;
    }

    .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .typing-dots span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-6px); }
    }

    /* 欢迎页 */
    .welcome {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      gap: 12px;
      color: var(--text-secondary);
    }

    .welcome-icon {
      font-size: 48px;
      margin-bottom: 8px;
    }

    .welcome h2 {
      font-size: 20px;
      color: var(--text-primary);
    }

    .welcome p {
      font-size: 14px;
      max-width: 400px;
      text-align: center;
      line-height: 1.5;
    }

    .welcome-commands {
      display: flex;
      gap: 8px;
      margin-top: 8px;
      flex-wrap: wrap;
      justify-content: center;
    }

    .welcome-commands button {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 6px 14px;
      border-radius: 16px;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .welcome-commands button:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    /* 输入区域 */
    .input-area {
      background: var(--bg-secondary);
      border-top: 1px solid var(--border);
      padding: 16px 20px;
      flex-shrink: 0;
    }

    .input-wrapper {
      display: flex;
      gap: 10px;
      align-items: flex-end;
      max-width: 900px;
      margin: 0 auto;
    }

    .input-wrapper textarea {
      flex: 1;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 16px;
      color: var(--text-primary);
      font-size: 14px;
      font-family: inherit;
      resize: none;
      outline: none;
      line-height: 1.5;
      max-height: 150px;
      min-height: 44px;
      transition: border-color 0.15s;
    }

    .input-wrapper textarea:focus {
      border-color: var(--accent);
    }

    .input-wrapper textarea::placeholder {
      color: var(--text-muted);
    }

    .send-btn {
      width: 44px;
      height: 44px;
      background: var(--accent);
      border: none;
      border-radius: 12px;
      color: #fff;
      font-size: 18px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
      flex-shrink: 0;
    }

    .send-btn:hover {
      background: var(--accent-hover);
    }

    .send-btn:disabled {
      background: var(--bg-tertiary);
      cursor: not-allowed;
      color: var(--text-muted);
    }

    /* 响应式 */
    @media (max-width: 640px) {
      .message { max-width: 90%; }
      .messages { padding: 12px; }
      .input-area { padding: 12px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="header-logo">🤖</span>
    <span class="header-title">Sophon</span>
    <div class="header-status">
      <span class="status-dot" id="statusDot"></span>
      <span id="statusText">连接中...</span>
    </div>
  </div>

  <div class="messages" id="messages">
    <div class="welcome" id="welcome">
      <div class="welcome-icon">🤖</div>
      <h2>Sophon AI 助手</h2>
      <p>输入消息开始对话，我可以帮你回答问题、执行命令、读写文件等。</p>
      <div class="welcome-commands">
        <button onclick="sendQuickMessage('/help')">📖 帮助</button>
        <button onclick="sendQuickMessage('/tools')">🔧 工具列表</button>
        <button onclick="sendQuickMessage('/status')">📊 状态</button>
        <button onclick="sendQuickMessage('你好，介绍一下你自己')">👋 打招呼</button>
      </div>
    </div>

    <div class="typing-indicator" id="typingIndicator">
      <div class="message-avatar">🤖</div>
      <div class="typing-dots">
        <span></span><span></span><span></span>
      </div>
    </div>
  </div>

  <div class="input-area">
    <div class="input-wrapper">
      <textarea
        id="messageInput"
        placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
        rows="1"
      ></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendMessage()" disabled>
        ↑
      </button>
    </div>
  </div>

  <script>
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const typingIndicator = document.getElementById('typingIndicator');
    const welcomeEl = document.getElementById('welcome');

    let ws = null;
    let isWaiting = false;

    // === WebSocket 连接 ===
    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host);

      ws.onopen = () => {
        statusDot.classList.add('connected');
        statusText.textContent = '已连接';
        sendBtn.disabled = false;
        inputEl.focus();
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleServerMessage(data);
      };

      ws.onclose = () => {
        statusDot.classList.remove('connected');
        statusText.textContent = '已断开';
        sendBtn.disabled = true;
        // 自动重连
        setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        statusDot.classList.remove('connected');
        statusText.textContent = '连接错误';
      };
    }

    function handleServerMessage(data) {
      switch (data.type) {
        case 'connected':
          break;
        case 'response':
          hideTyping();
          isWaiting = false;
          addMessage('assistant', data.text);
          break;
      }
    }

    // === 消息发送 ===
    function sendMessage() {
      const text = inputEl.value.trim();
      if (!text || !ws || ws.readyState !== WebSocket.OPEN || isWaiting) return;

      // 隐藏欢迎页
      if (welcomeEl) welcomeEl.style.display = 'none';

      addMessage('user', text);
      ws.send(JSON.stringify({ type: 'message', text }));

      inputEl.value = '';
      inputEl.style.height = 'auto';
      isWaiting = true;
      showTyping();
    }

    function sendQuickMessage(text) {
      inputEl.value = text;
      sendMessage();
    }

    // === UI 辅助 ===
    function addMessage(role, text) {
      const msgEl = document.createElement('div');
      msgEl.className = 'message ' + role;

      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = role === 'user' ? '👤' : '🤖';

      const content = document.createElement('div');
      content.className = 'message-content';
      content.innerHTML = formatMessage(text);

      msgEl.appendChild(avatar);
      msgEl.appendChild(content);

      // 插入到 typing indicator 之前
      messagesEl.insertBefore(msgEl, typingIndicator);
      scrollToBottom();
    }

    function formatMessage(text) {
      // 代码块
      text = text.replace(/\`\`\`(\\w*)?\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
      // 行内代码
      text = text.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      // 粗体
      text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      // 换行
      text = text.replace(/\\n/g, '<br>');
      return text;
    }

    function showTyping() {
      typingIndicator.classList.add('visible');
      scrollToBottom();
    }

    function hideTyping() {
      typingIndicator.classList.remove('visible');
    }

    function scrollToBottom() {
      requestAnimationFrame(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }

    // === 输入框处理 ===
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
    });

    // === 启动 ===
    connect();
  </script>
</body>
</html>`;
}
