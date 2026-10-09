import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
export interface HistoryRequest {
  id: string
  startedAt: string
  content: string
}
export function historyFilename(request: HistoryRequest): string {
  if (
    !request ||
    !/^[a-f0-9-]{36}$/i.test(request.id) ||
    !Number.isFinite(Date.parse(request.startedAt)) ||
    typeof request.content !== 'string' ||
    !request.content.trim() ||
    request.content.length > 1000000
  )
    throw new Error('Invalid history record')
  const d = new Date(request.startedAt),
    pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_${request.id}.md`
}
export async function saveHistory(directory: string, request: HistoryRequest): Promise<string> {
  const filename = historyFilename(request)
  await mkdir(directory, { recursive: true })
  const target = join(directory, filename),
    temporary = join(directory, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, request.content, { flag: 'wx', mode: 0o600 })
    try {
      await link(temporary, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if ((await readFile(target, 'utf8')) !== request.content) throw new Error('History collision')
    }
    return target
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
