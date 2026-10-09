export const script = [
  {
    en: 'Today, let’s talk about building a more reliable AI application.',
    zh: '今天，我们来聊聊如何构建一个更可靠的 AI 应用。',
  },
  {
    en: 'A good RAG pipeline starts with the quality of your data.',
    zh: '一条好的 RAG 流水线，始于高质量的数据。',
  },
  {
    en: 'Before we add more features, we need to understand the real problem.',
    zh: '在添加更多功能之前，我们需要先理解真正的问题。',
  },
  {
    en: 'The goal is simple: help people find the right information, faster.',
    zh: '目标很简单：帮助人们更快地找到正确的信息。',
  },
  {
    en: 'We use Embedding to connect a question with relevant knowledge.',
    zh: '我们使用 Embedding，将问题与相关知识关联起来。',
  },
  {
    en: 'But retrieval is only one part of the experience.',
    zh: '不过，检索只是整个体验中的一个环节。',
  },
  {
    en: '我们需要关注 latency, especially when the response is streaming.',
    zh: '我们需要关注延迟，尤其是在响应以流式方式输出时。',
  },
  {
    en: 'A small improvement in response time can make a big difference.',
    zh: '响应时间的一点改善，就可能带来明显的体验提升。',
  },
  {
    en: 'The Agent should use a tool only when it actually needs one.',
    zh: 'Agent 只应在确实需要时调用工具。',
  },
  {
    en: 'Keep the original context, and make each step easy to verify.',
    zh: '保留原始上下文，并让每一步都易于验证。',
  },
  {
    en: 'Let’s open a Pull Request and review the changes together.',
    zh: '让我们提交一个 PR，一起检查这些改动。',
  },
  {
    en: 'Start small, test carefully, and improve with real feedback.',
    zh: '从小处开始，认真测试，再根据真实反馈持续改进。',
  },
]
export function terminology(text: string, enabled: boolean): string {
  if (enabled) return text
  return text
    .replaceAll('RAG', '检索增强生成')
    .replaceAll('Embedding', '向量嵌入')
    .replaceAll('Agent', '智能体')
    .replaceAll('PR', '拉取请求')
}
