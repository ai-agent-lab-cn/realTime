// Read llama.cpp's chat-completion SSE stream without buffering the whole translation.
export async function readTranslationStream(
  response: Response,
  signal: AbortSignal,
  onProgress?: (text: string) => void,
): Promise<string> {
  if (!response.body) throw new Error('翻译响应为空')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '',
    text = '',
    stopped = false,
    done = false
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  function line(value: string) {
    if (!value.startsWith('data:')) return
    const data = value.slice(5).trim()
    if (data === '[DONE]') {
      done = true
      return
    }
    const event = JSON.parse(data)
    if (event.error) throw new Error('翻译流返回错误')
    const choice = event.choices?.[0]
    if (!choice) return // Optional usage-only event.
    const delta = choice.delta?.content
    if (delta != null && typeof delta !== 'string') throw new Error('翻译流格式无效')
    if (typeof delta === 'string' && delta) {
      if (stopped) throw new Error('翻译完成后仍有内容')
      text += delta
      if (text.length > 12000) throw new Error('翻译内容超长')
      onProgress?.(text.trim())
    }
    if (choice.finish_reason != null) {
      if (choice.finish_reason !== 'stop') throw new Error('翻译未完整完成')
      stopped = true
    }
  }
  try {
    while (!done) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      if (buffer.length > 65536) throw new Error('翻译流事件超长')
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, end).replace(/\r$/, ''))
        buffer = buffer.slice(end + 1)
        if (done) break
      }
      if (chunk.done) break
    }
    if (!done || !stopped || !text.trim()) throw new Error('翻译未完整完成')
    return text.trim()
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
