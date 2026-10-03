import { allRows, commitRows, listRows } from '@/data/local-store'
import {
  computeGradation,
  computeSedimentDischarge,
  gradationSummaryText,
  measurementVerdict,
  parseMeasurement,
  sampleKey,
  summarizeSamples,
} from '@/data/sediment-rules'
import type { GradationResult, SedimentSummary } from '@/data/sediment-rules'
import type { ActionResult, EntryRow } from '@/data/types'

// 泥沙监测业务读写：样本登记/补录、输沙率改写、归档入整编清单都走这里，
// 判定与计算一律调用 sediment-rules 里的共用规则，页面不做业务判断。
const SAMPLE_KEY = 'sediment'
const ARCHIVE_KEY = 'sedimentArchive'

const SAMPLE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/

export type SedimentSampleInput = {
  记录编号: string
  站点编号: string
  采样时间: string
  含沙量: string
  流量: string
  颗粒级配: string
  采样人: string
}

export type GradationPanelItem = {
  id: number
  记录编号: string
  采样时间: string
  verdict: '有效' | '零含沙量' | '缺测'
  result: GradationResult | null
  resultText: string
}

export function listSedimentSamples(): EntryRow[] {
  return listRows(SAMPLE_KEY)
}

/** 汇总展示：与级配面板、整编清单共用同一套 summarizeSamples 规则。 */
export function sedimentSummary(): SedimentSummary {
  return summarizeSamples(listRows(SAMPLE_KEY))
}

/**
 * 颗粒级配面板：每个样本的级配结果都按样本 id 单独计算并绑定，
 * 改写输沙率只动输沙率本身，面板不会出现结果与样本错位。
 */
export function gradationPanel(): GradationPanelItem[] {
  return listRows(SAMPLE_KEY).map((row) => {
    const raw = typeof row.颗粒级配 === 'string' ? row.颗粒级配.trim() : ''
    let result: GradationResult | null = null
    let resultText: string
    if (raw) {
      try {
        result = computeGradation(raw)
        resultText = result.summary
      } catch (error) {
        resultText = `级配数据无法解析：${error instanceof Error ? error.message : '格式错误'}`
      }
    } else {
      resultText = safeGradationText(row.含沙量, raw)
    }
    return {
      id: Number(row.id),
      记录编号: String(row.记录编号 ?? ''),
      采样时间: String(row.采样时间 ?? ''),
      verdict: measurementVerdict(row.含沙量),
      result,
      resultText,
    }
  })
}

/**
 * 保存泥沙样本（登记与补录同一条路径）。
 * 先完成样本、级配、汇总所需的全部校验与计算，再一次提交落盘：
 * 任何一步失败都不写入，保证三者整体成功或整体不变。
 * 补录冲突：同一记录编号只接受先提交的那一份，后来的补录直接拒绝。
 */
export function saveSedimentSample(input: SedimentSampleInput): ActionResult {
  const 记录编号 = input.记录编号.trim()
  const 站点编号 = input.站点编号.trim()
  const 采样时间 = input.采样时间.trim()
  const 采样人 = input.采样人.trim()
  if (!记录编号) {
    return { ok: false, message: '记录编号不能为空' }
  }
  if (!站点编号) {
    return { ok: false, message: '站点编号不能为空' }
  }
  if (!SAMPLE_TIME_PATTERN.test(采样时间)) {
    return { ok: false, message: '采样时间应写成 2026-10-03 08:30 这样的格式' }
  }
  const samples = listRows(SAMPLE_KEY)
  if (samples.some((row) => String(row.记录编号 ?? '').trim() === 记录编号)) {
    return {
      ok: false,
      message: `记录编号 ${记录编号} 已存在，补录冲突：只接受先提交的那一份，本次补录未入库`,
    }
  }

  const concentration = parseMeasurement(input.含沙量)
  if (concentration.kind === 'invalid') {
    return { ok: false, message: '含沙量必须是数字；留空表示缺测，0 表示实测为零' }
  }
  if (concentration.kind === 'ok' && concentration.value < 0) {
    return { ok: false, message: '含沙量不能为负数' }
  }
  const concentrationValue = concentration.kind === 'ok' ? concentration.value : null

  const flow = parseMeasurement(input.流量)
  if (flow.kind === 'invalid') {
    return { ok: false, message: '流量必须是数字' }
  }
  if (flow.kind === 'ok' && flow.value < 0) {
    return { ok: false, message: '流量不能为负数' }
  }
  if (concentrationValue !== null && flow.kind === 'missing') {
    return { ok: false, message: '已测定含沙量的样本必须同时登记流量，才能计算输沙率' }
  }
  const flowValue = flow.kind === 'ok' ? flow.value : null

  const rawGradation = input.颗粒级配.trim()
  if (concentrationValue !== null && concentrationValue > 0 && !rawGradation) {
    return { ok: false, message: '含沙量大于 0 的样本必须录入颗粒级配，否则不予保存' }
  }
  if (rawGradation) {
    try {
      computeGradation(rawGradation)
    } catch (error) {
      return {
        ok: false,
        message: `颗粒级配录入有误：${error instanceof Error ? error.message : '格式错误'}`,
      }
    }
  }

  const discharge = computeSedimentDischarge(concentrationValue, flowValue)
  const row: EntryRow = {
    id: nextId(samples),
    status: '已采集',
    pending: true,
    abnormal: false,
    记录编号,
    站点编号,
    采样时间,
    颗粒级配: rawGradation,
    级配结果: gradationSummaryText(concentrationValue, rawGradation),
    采样人,
    记录状态: '已采集',
  }
  if (concentrationValue !== null) {
    row.含沙量 = concentrationValue
  }
  if (flowValue !== null) {
    row.流量 = flowValue
  }
  if (discharge !== null) {
    row.输沙率 = discharge
  }
  commitRows({ ...allRows(), [SAMPLE_KEY]: [...samples, row] })
  return { ok: true, message: `泥沙样本 ${记录编号} 已保存，级配与汇总已同步更新` }
}

/**
 * 改写输沙率：按新登记的流量重算输沙率。
 * 只动流量与输沙率，原始采样时间、颗粒级配与原级配结果保持不动，
 * 级配面板按样本 id 取数，不会因改写而错位。
 */
export function rewriteSedimentDischarge(id: number, flowText: string): ActionResult {
  const samples = listRows(SAMPLE_KEY)
  const index = samples.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的泥沙样本` }
  }
  const flow = parseMeasurement(flowText)
  if (flow.kind !== 'ok' || flow.value < 0) {
    return { ok: false, message: '改写输沙率需要登记一个不小于 0 的流量数字' }
  }
  const row = samples[index]
  const concentration = parseMeasurement(row.含沙量)
  const discharge = computeSedimentDischarge(
    concentration.kind === 'ok' ? concentration.value : null,
    flow.value,
  )
  const updated: EntryRow = { ...row, 流量: flow.value }
  if (discharge === null) {
    delete updated.输沙率
  } else {
    updated.输沙率 = discharge
  }
  const next = [...samples]
  next[index] = updated
  commitRows({ ...allRows(), [SAMPLE_KEY]: next })
  const dischargeText = discharge === null ? '缺测，无法计算' : `${discharge} kg/s`
  return { ok: true, message: `样本 ${String(row.记录编号)} 的输沙率已改写为 ${dischargeText}` }
}

/**
 * 归档样本进整编清单。
 * 重复样本只保留首次归档的那一份（含原始采样时间与原级配），
 * 再次归档同一样本直接拒绝；源样本标记与归档记录在同一次提交里落盘。
 */
export function archiveSedimentSample(id: number): ActionResult {
  const samples = listRows(SAMPLE_KEY)
  const index = samples.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的泥沙样本` }
  }
  const row = samples[index]
  const archived = listRows(ARCHIVE_KEY)
  if (row.archived === true || archived.some((item) => sampleKey(item) === sampleKey(row))) {
    return {
      ok: false,
      message: `样本 ${String(row.记录编号)} 已归档，整编清单只保留首次归档的那一份`,
    }
  }
  const archivedAt = nowText()
  const entry: EntryRow = { ...row, archived: true, 归档时间: archivedAt }
  const nextSamples = [...samples]
  nextSamples[index] = { ...row, archived: true, 归档时间: archivedAt }
  commitRows({ ...allRows(), [SAMPLE_KEY]: nextSamples, [ARCHIVE_KEY]: [...archived, entry] })
  return { ok: true, message: `样本 ${String(row.记录编号)} 已归档，整编清单已更新` }
}

/**
 * 整编清单：数据整编模块从这里读取归档样本。
 * 按样本键去重（保留首次归档的一份），并带上共用规则算出的级配计算结果。
 */
export function listSedimentArchive(): EntryRow[] {
  const seen = new Set<string>()
  const rows: EntryRow[] = []
  for (const row of listRows(ARCHIVE_KEY)) {
    const key = sampleKey(row)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    rows.push({ ...row, 级配计算结果: safeGradationText(row.含沙量, row.颗粒级配) })
  }
  return rows
}

/** 整编清单的汇总展示，与采样页共用同一套统计口径。 */
export function archiveSummary(): SedimentSummary {
  return summarizeSamples(listSedimentArchive())
}

function safeGradationText(concentration: unknown, rawGradation: unknown): string {
  try {
    return gradationSummaryText(concentration, rawGradation)
  } catch (error) {
    return `级配数据无法解析：${error instanceof Error ? error.message : '格式错误'}`
  }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nowText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}
