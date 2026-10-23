const POINT_CODE_PATTERN = /^[A-Z0-9_-]{1,64}$/

export function parsePointCode(raw: string): string {
  const value = raw.trim()
  if (!value) throw new Error('请输入点位编号或扫描点位二维码')

  let candidate = value
  if (/^https?:\/\//i.test(value)) {
    const match = value.match(/(?:^|\/)p\/([^/?#]+)(?:[/?#]|$)/i)
    if (!match) throw new Error('这不是 hikes 点位二维码，请扫描点位牌上的二维码')
    try {
      candidate = decodeURIComponent(match[1])
    } catch {
      throw new Error('二维码中的点位编号格式不正确')
    }
  } else if (/(?:^|\/)p\//i.test(value)) {
    const match = value.match(/(?:^|\/)p\/([^/?#]+)(?:[/?#]|$)/i)
    if (!match) throw new Error('二维码中的点位编号格式不正确')
    try {
      candidate = decodeURIComponent(match[1])
    } catch {
      throw new Error('二维码中的点位编号格式不正确')
    }
  }

  const code = candidate.trim().toUpperCase()
  if (!POINT_CODE_PATTERN.test(code)) throw new Error('点位编号格式不正确，请检查后重试')
  return code
}
