import { listRows, saveModules } from './local-store'
import type { ActionResult, EntryRow } from './types'

// 泥沙业务的共用规则：零值判定、级配计算、汇总展示、样本身份与整体保存都收拢在这里，
// 采样页面和整编清单都走这一套写法，不再各写各的。

export const SEDIMENT_KEY = 'sediment'
export const SEDIMENT_SUMMARY_KEY = 'sediment-summary'
export const ARCHIVED_STATUS = '已归档'

const MISSING_TOKENS = new Set(['', '缺测', 'null', 'undefined', '—', '-', 'n/a', 'na', 'none'])

// —— 零值判定 ——
// 0 是有效实测值（清水样本），只有空值或缺测标记才算缺测。
export function isMissingReading(value: unknown): boolean {
  if (value === null || value === undefined) return true
  return MISSING_TOKENS.has(String(value).trim().toLowerCase())
}

export function isZeroReading(value: unknown): boolean {
  if (isMissingReading(value)) return false
  const num = Number(String(value).trim())
  return Number.isFinite(num) && num === 0
}

// 统一展示写法：缺测显示「缺测」，零值原样显示「0」。
export function readingText(value: unknown): string {
  if (isMissingReading(value)) return '缺测'
  return String(value).trim()
}

function toNonNegativeNumber(value: unknown, label: string): number {
  if (isMissingReading(value)) throw new Error(`${label}缺测，无法参与计算`)
  const num = Number(String(value).trim())
  if (!Number.isFinite(num) || num < 0) throw new Error(`${label}必须是不小于 0 的数值`)
  return num
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

// 统一采样时间写法：YYYY-MM-DD HH:mm，兼容 datetime-local 的 T 分隔。
export function normalizeSampleTime(value: unknown): string {
  if (isMissingReading(value)) return ''
  return String(value).trim().replace(/[Tt]/, ' ').replace(/\s+/g, ' ')
}

// 原始采样时间一经写入不再改动；缺失时回看采样时间。
export function originalSampleTime(row: EntryRow): string {
  const original = normalizeSampleTime(row['原始采样时间'])
  if (original) return original
  return normalizeSampleTime(row['采样时间'])
}

// 样本身份：站点编号 + 原始采样时间。补录、归档、去重都按这个认定同一份样本。
export function sampleIdentity(row: EntryRow): string {
  return `${String(row['站点编号'] ?? '').trim()}@${originalSampleTime(row)}`
}

// —— 级配计算 ——
export type GradationFraction = { 粒径: string; 占比: number; 分级输沙率: number }

export type GradationResult = {
  fractions: GradationFraction[]
  合计占比: number
  输沙率: number
  text: string
}

// 统一级配写法：「粒径:占比,粒径:占比…」，占比合计必须是 100%。
export function parseGradation(raw: unknown): { 粒径: string; 占比: number }[] {
  if (isMissingReading(raw)) return []
  const parts = String(raw).split(/[,，;；]/).map((item) => item.trim()).filter(Boolean)
  return parts.map((part) => {
    const [diameter, percent] = part.split(/[:：]/).map((item) => item.trim())
    const num = Number(percent)
    if (!diameter || !Number.isFinite(num) || num < 0) {
      throw new Error(`颗粒级配「${part}」写法不对，应为 粒径:占比`)
    }
    return { 粒径: diameter, 占比: num }
  })
}

// 级配计算：同一份样本快照一次算完，每档直接乘当前输沙率。
// 输沙率改写后重算走的还是这套函数，面板结果不会错位。
export function computeGradation(sample: Record<string, unknown>): GradationResult {
  const fractions = parseGradation(sample['颗粒级配'])
  const rate = isMissingReading(sample['输沙率']) ? 0 : toNonNegativeNumber(sample['输沙率'], '输沙率')
  const total = round3(fractions.reduce((sum, item) => sum + item.占比, 0))
  if (fractions.length > 0 && Math.abs(total - 100) > 0.5) {
    throw new Error(`颗粒级配占比合计 ${total}%，应为 100%`)
  }
  const aligned = fractions.map((item) => ({ ...item, 分级输沙率: round3((rate * item.占比) / 100) }))
  const text = aligned.map((item) => `${item.粒径}mm ${item.占比}%→${item.分级输沙率}kg/s`).join('；')
  return { fractions: aligned, 合计占比: total, 输沙率: rate, text }
}

// 展示用：算不出来就给原因，不抛错。
export function gradationText(row: EntryRow): string {
  if (isMissingReading(row['颗粒级配'])) return '缺测'
  try {
    return computeGradation(row).text
  } catch (error) {
    return error instanceof Error ? error.message : '级配写法有误'
  }
}

// —— 汇总展示 ——
export type SedimentSummary = {
  样本总数: number
  本月采样数: number
  缺测数: number
  零值数: number
  待审核数: number
  异常数: number
  平均含沙量: number | null
  合计输沙率: number
}

export function summarizeSamples(rows: EntryRow[], now: Date = new Date()): SedimentSummary {
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  let 缺测数 = 0
  let 零值数 = 0
  let 本月采样数 = 0
  let 待审核数 = 0
  let 异常数 = 0
  let concentrationSum = 0
  let concentrationCount = 0
  let rateSum = 0
  for (const row of rows) {
    const concentration = row['含沙量']
    if (isMissingReading(concentration)) {
      缺测数 += 1
    } else {
      const num = Number(String(concentration).trim())
      // 零含沙量照样进平均，不按缺测剔除
      if (Number.isFinite(num)) {
        concentrationSum += num
        concentrationCount += 1
      }
      if (isZeroReading(concentration)) 零值数 += 1
    }
    if (!isMissingReading(row['输沙率'])) {
      const num = Number(String(row['输沙率']).trim())
      if (Number.isFinite(num)) rateSum += num
    }
    if (originalSampleTime(row).startsWith(monthKey)) 本月采样数 += 1
    if (String(row.status) === '待审核') 待审核数 += 1
    if (row.abnormal) 异常数 += 1
  }
  return {
    样本总数: rows.length,
    本月采样数,
    缺测数,
    零值数,
    待审核数,
    异常数,
    平均含沙量: concentrationCount > 0 ? round3(concentrationSum / concentrationCount) : null,
    合计输沙率: round3(rateSum),
  }
}

export function sedimentSummary(): SedimentSummary {
  return summarizeSamples(listRows(SEDIMENT_KEY))
}

// —— 重复样本去重 ——
// 重复样本只保留先入库（id 最小）的一份；若保留的这份缺级配，
// 从被合并的重复件里把原级配补回来，归档数据本身不改动。
export function dedupeSamples(rows: EntryRow[]): EntryRow[] {
  const byIdentity = new Map<string, EntryRow>()
  const sorted = [...rows].sort((a, b) => Number(a.id) - Number(b.id))
  for (const row of sorted) {
    const key = sampleIdentity(row)
    const kept = byIdentity.get(key)
    if (!kept) {
      byIdentity.set(key, row)
      continue
    }
    if (isMissingReading(kept['颗粒级配']) && !isMissingReading(row['颗粒级配'])) {
      byIdentity.set(key, {
        ...kept,
        颗粒级配: row['颗粒级配'],
        输沙率: isMissingReading(kept['输沙率']) ? row['输沙率'] : kept['输沙率'],
      })
    }
  }
  return [...byIdentity.values()]
}

// —— 整编清单：读取级配计算结果 ——
export type CompilationItem = { row: EntryRow; gradationText: string }

export function archivedCompilation(): {
  items: CompilationItem[]
  mergedCount: number
  summary: SedimentSummary
} {
  const archived = listRows(SEDIMENT_KEY).filter((row) => String(row.status) === ARCHIVED_STATUS)
  const deduped = dedupeSamples(archived)
  return {
    items: deduped.map((row) => ({ row, gradationText: gradationText(row) })),
    mergedCount: archived.length - deduped.length,
    summary: summarizeSamples(deduped),
  }
}

// —— 整体保存：样本、级配、汇总先全部算好，再一次落库；任何一步失败都不写 ——
export type NewSampleInput = {
  站点编号: string
  采样时间: string
  含沙量: string
  输沙率: string
  颗粒级配: string
  采样人: string
}

function snapshotRow(summary: SedimentSummary): EntryRow {
  return {
    id: 1,
    status: '已汇总',
    pending: false,
    abnormal: false,
    样本总数: summary.样本总数,
    缺测数: summary.缺测数,
    零值数: summary.零值数,
    平均含沙量: summary.平均含沙量 === null ? '缺测' : summary.平均含沙量,
    合计输沙率: summary.合计输沙率,
    汇总时间: new Date().toISOString(),
  }
}

function persistAll(rows: EntryRow[]): void {
  saveModules({
    [SEDIMENT_KEY]: rows,
    [SEDIMENT_SUMMARY_KEY]: [snapshotRow(summarizeSamples(rows))],
  })
}

export function lastSummarySnapshot(): EntryRow | null {
  const [row] = listRows(SEDIMENT_SUMMARY_KEY)
  return row ?? null
}

// 补录泥沙样本：同一站点同一采样时间只接受先入库的一份，冲突直接拒写。
export function saveSedimentBundle(input: NewSampleInput): ActionResult {
  const station = input.站点编号.trim()
  const time = normalizeSampleTime(input.采样时间)
  if (!station) return { ok: false, message: '站点编号不能为空' }
  if (!time) return { ok: false, message: '采样时间不能为空' }
  try {
    if (!isMissingReading(input.含沙量)) toNonNegativeNumber(input.含沙量, '含沙量')
    if (!isMissingReading(input.输沙率)) toNonNegativeNumber(input.输沙率, '输沙率')
    const rows = listRows(SEDIMENT_KEY)
    const draft: EntryRow = {
      id: 0,
      status: '已采集',
      pending: true,
      abnormal: false,
      记录编号: '',
      站点编号: station,
      采样时间: time,
      原始采样时间: time,
      含沙量: input.含沙量.trim(),
      输沙率: input.输沙率.trim(),
      颗粒级配: input.颗粒级配.trim(),
      采样人: input.采样人.trim(),
      记录状态: '已采集',
    }
    const identity = sampleIdentity(draft)
    if (rows.some((row) => sampleIdentity(row) === identity)) {
      return { ok: false, message: `${station} 在 ${time} 已有样本，补录冲突只保留先入库的一份，本次未写入` }
    }
    const gradation = computeGradation(draft)
    const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    const seq =
      rows.reduce((max, row) => {
        const match = /^SEDI-(\d+)$/.exec(String(row['记录编号'] ?? ''))
        return match ? Math.max(max, Number(match[1])) : max
      }, 0) + 1
    const row: EntryRow = {
      ...draft,
      id,
      记录编号: `SEDI-${String(seq).padStart(4, '0')}`,
      级配结果: gradation.text,
    }
    persistAll([...rows, row])
    return { ok: true, message: `泥沙样本 ${row['记录编号']} 已登记，样本、级配与汇总已整体保存` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '保存失败，未写入任何数据' }
  }
}

// 归档：盖上原始采样时间，级配算得出来才归档，样本与汇总一起落库。
export function archiveSedimentSample(id: number): ActionResult {
  const rows = listRows(SEDIMENT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的泥沙监测记录` }
  const row = rows[index]
  if (String(row.status) === ARCHIVED_STATUS) return { ok: false, message: '这份样本已归档，不用重复归档' }
  const time = originalSampleTime(row)
  if (!time) return { ok: false, message: '这份样本缺采样时间，先补录采样时间再归档' }
  try {
    const stamped: EntryRow = { ...row, 原始采样时间: time }
    const gradation = computeGradation(stamped)
    const updated: EntryRow = {
      ...stamped,
      status: ARCHIVED_STATUS,
      记录状态: ARCHIVED_STATUS,
      pending: false,
      级配结果: gradation.text,
    }
    const next = [...rows]
    next[index] = updated
    persistAll(next)
    return { ok: true, message: `泥沙样本已归档，原始采样时间 ${time} 与级配结果一并保存` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '级配计算失败，未归档' }
  }
}

// 改写输沙率：只动输沙率，原始采样时间不动；级配按同一套规则重算，面板不错位。
export function rewriteTransportRate(id: number, rawRate: string): ActionResult {
  const rows = listRows(SEDIMENT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的泥沙监测记录` }
  try {
    const rate = toNonNegativeNumber(rawRate, '输沙率')
    const updated: EntryRow = { ...rows[index], 输沙率: String(rate) }
    const gradation = computeGradation(updated)
    const next = [...rows]
    next[index] = { ...updated, 级配结果: gradation.text }
    persistAll(next)
    return { ok: true, message: `输沙率已改写为 ${rate}，级配面板已按同一规则重算` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '输沙率改写失败' }
  }
}
