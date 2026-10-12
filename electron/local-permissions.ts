export function allowAudioPermission(request: {
  active: boolean
  trusted: boolean
  mainFrame: boolean
  permission: string
  types: string[]
}): boolean {
  return (
    request.active &&
    request.trusted &&
    request.mainFrame &&
    request.permission === 'media' &&
    request.types.length === 1 &&
    request.types[0] === 'audio'
  )
}
export function allowResource(url: string, development: boolean): boolean {
  try {
    const parsed = new URL(url)
    if (['file:', 'data:', 'blob:', 'devtools:'].includes(parsed.protocol)) return true
    return development && ['http://127.0.0.1:5187', 'ws://127.0.0.1:5187'].includes(parsed.origin)
  } catch {
    return false
  }
}
