// 泥沙监测共用规则：零值判定、级配计算、汇总展示全部收拢在这一份里。
// 采样页、颗粒级配面板、整编清单只允许调用这里的规则，不再各自写一套，
// 避免出现「采样页把 0 当缺测、面板又对不上样本」这类口径漂移。

/** 测定值解析结果：缺测 / 无法解析 / 有效值（0 是有效值）。 */
export type MeasurementParse =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'ok'; value: number }

/**
 * 缺测判定：只有空值（null / undefined / 空白串 / NaN）才算缺测。
 * 0 是真实测出来的含沙量，绝不能当缺测。
 */
export function isMissingValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }
  if (typeof value === 'string' && value.trim() === '') {
    return true
  }
  return typeof value === 'number' && Number.isNaN(value)
}

/** 把录入值解析成测定值：空值算缺测，非数字算无法解析，其余（含 0）是有效值。 */
export function parseMeasurement(value: unknown): MeasurementParse {
  if (isMissingValue(value)) {
    return { kind: 'missing' }
  }
  const num = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(num)) {
    return { kind: 'invalid' }
  }
  return { kind: 'ok', value: num }
}

/** 测定判定标签：采样页、级配面板、整编清单用同一套文案。 */
export function measurementVerdict(value: unknown): '有效' | '零含沙量' | '缺测' {
  const parsed = parseMeasurement(value)
  if (parsed.kind === 'missing') {
    return '缺测'
  }
  if (parsed.kind === 'ok' && parsed.value === 0) {
    return '零含沙量'
  }
  return '有效'
}

/** 含沙量展示：缺测显示「缺测」，其余（含 0）按数值显示。 */
export function formatConcentration(value: unknown): string {
  const parsed = parseMeasurement(value)
  if (parsed.kind === 'missing') {
    return '缺测'
  }
  if (parsed.kind === 'invalid') {
    return '—'
  }
  return formatNumber(parsed.value)
}

/** 输沙率展示：算不出来显示「—」，0 是有效结果照常显示。 */
export function formatDischarge(value: unknown): string {
  const parsed = parseMeasurement(value)
  if (parsed.kind !== 'ok') {
    return '—'
  }
  return formatNumber(parsed.value)
}

/**
 * 输沙率(kg/s) = 含沙量(kg/m³) × 流量(m³/s)。
 * 任一缺测则无法计算返回 null；零含沙量算出 0，是有效结果。
 */
export function computeSedimentDischarge(
  concentration: number | null,
  flow: number | null,
): number | null {
  if (concentration === null || flow === null) {
    return null
  }
  return round3(concentration * flow)
}

/** 颗粒级配曲线点：粒径(mm) 与小于该粒径的累计百分数(%)。 */
export type GradationPoint = {
  diameter: number
  percentFiner: number
}

/** 级配计算结果：特征粒径、平均粒径与展示摘要，面板和整编清单共用。 */
export type GradationResult = {
  points: GradationPoint[]
  d16: number | null
  d50: number | null
  d84: number | null
  meanDiameter: number | null
  summary: string
}

const PAIR_SEPARATOR = /[,，;；\s]+/

/**
 * 解析颗粒级配原始录入，格式为「粒径:累计百分数」的序列，
 * 例如「0.062:18, 0.125:42, 0.25:68, 0.5:88, 1:100」。
 * 解析失败一律抛错，由调用方决定整条记录如何处理（保存时整体失败）。
 */
export function parseGradation(raw: string): GradationPoint[] {
  const text = raw.trim()
  if (!text) {
    throw new Error('颗粒级配不能为空')
  }
  const points = text
    .split(PAIR_SEPARATOR)
    .filter((token) => token !== '')
    .map((token) => {
      const parts = token.split(/[:：]/)
      if (parts.length !== 2) {
        throw new Error(`级配点「${token}」应写成 粒径:累计百分数`)
      }
      const diameter = Number(parts[0])
      const percentFiner = Number(parts[1])
      if (!Number.isFinite(diameter) || diameter <= 0) {
        throw new Error(`级配点「${token}」的粒径必须是正数`)
      }
      if (!Number.isFinite(percentFiner) || percentFiner < 0 || percentFiner > 100) {
        throw new Error(`级配点「${token}」的累计百分数必须在 0~100 之间`)
      }
      return { diameter, percentFiner }
    })
    .sort((a, b) => a.diameter - b.diameter)
  if (points.length < 2) {
    throw new Error('颗粒级配至少需要两个粒径级配点')
  }
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].diameter === points[i - 1].diameter) {
      throw new Error(`粒径 ${points[i].diameter}mm 出现了重复的级配点`)
    }
    if (points[i].percentFiner < points[i - 1].percentFiner) {
      throw new Error('累计百分数必须随粒径递增，请检查级配录入顺序')
    }
  }
  return points
}

/** 按对数线性内插求某一累计百分数对应的特征粒径；超出级配范围时返回 null。 */
function characteristicDiameter(points: GradationPoint[], percent: number): number | null {
  const first = points[0]
  const last = points[points.length - 1]
  if (percent < first.percentFiner || percent > last.percentFiner) {
    return null
  }
  for (let i = 0; i < points.length; i += 1) {
    if (points[i].percentFiner === percent) {
      return round3(points[i].diameter)
    }
    if (points[i].percentFiner > percent) {
      const upper = points[i]
      const lower = points[i - 1]
      const span = upper.percentFiner - lower.percentFiner
      if (span <= 0) {
        return round3(lower.diameter)
      }
      const ratio = (percent - lower.percentFiner) / span
      const logDiameter =
        Math.log(lower.diameter) + ratio * (Math.log(upper.diameter) - Math.log(lower.diameter))
      return round3(Math.exp(logDiameter))
    }
  }
  return null
}

/** 级配计算：解析原始录入并求特征粒径 d16/d50/d84、平均粒径与展示摘要。 */
export function computeGradation(raw: string): GradationResult {
  const points = parseGradation(raw)
  const d16 = characteristicDiameter(points, 16)
  const d50 = characteristicDiameter(points, 50)
  const d84 = characteristicDiameter(points, 84)
  const available = [d16, d50, d84].filter((item): item is number => item !== null)
  const meanDiameter = available.length
    ? round3(Math.exp(available.reduce((sum, item) => sum + Math.log(item), 0) / available.length))
    : null
  const parts: string[] = []
  if (d50 !== null) {
    parts.push(`d50=${formatNumber(d50)}mm`)
  }
  if (meanDiameter !== null) {
    parts.push(`平均粒径=${formatNumber(meanDiameter)}mm`)
  }
  parts.push(`共${points.length}级`)
  return { points, d16, d50, d84, meanDiameter, summary: parts.join(' · ') }
}

/**
 * 级配结果展示文本：采样页保存时、级配面板、整编清单都用这一份。
 * 缺测与零含沙量都没有级配可算，但文案要区分——零值是有效测定。
 */
export function gradationSummaryText(concentration: unknown, rawGradation: unknown): string {
  const verdict = measurementVerdict(concentration)
  if (verdict === '缺测') {
    return '缺测，无级配'
  }
  const raw = typeof rawGradation === 'string' ? rawGradation.trim() : ''
  if (!raw) {
    return verdict === '零含沙量' ? '零含沙量，无级配' : '未录入级配'
  }
  return computeGradation(raw).summary
}

/** 汇总展示规则：样本总数、有效（含零值）、零值、缺测与平均含沙量、合计输沙率。 */
export type SedimentSummary = {
  total: number
  valid: number
  zero: number
  missing: number
  avgConcentration: number | null
  totalDischarge: number | null
}

/** 汇总统计：零含沙量计入有效样本与平均值，只有缺测被排除。 */
export function summarizeSamples(samples: ReadonlyArray<Record<string, unknown>>): SedimentSummary {
  let valid = 0
  let zero = 0
  let missing = 0
  let concentrationSum = 0
  let dischargeSum = 0
  let dischargeCount = 0
  for (const sample of samples) {
    const parsed = parseMeasurement(sample.含沙量)
    if (parsed.kind === 'ok') {
      valid += 1
      concentrationSum += parsed.value
      if (parsed.value === 0) {
        zero += 1
      }
    } else {
      missing += 1
    }
    const discharge = parseMeasurement(sample.输沙率)
    if (discharge.kind === 'ok') {
      dischargeSum += discharge.value
      dischargeCount += 1
    }
  }
  return {
    total: samples.length,
    valid,
    zero,
    missing,
    avgConcentration: valid > 0 ? round3(concentrationSum / valid) : null,
    totalDischarge: dischargeCount > 0 ? round3(dischargeSum) : null,
  }
}

/**
 * 样本去重键：记录编号 + 原始采样时间。
 * 归档入整编清单、补录冲突判定都用它，重复样本只保留先入库的一份。
 */
export function sampleKey(sample: Record<string, unknown>): string {
  return `${String(sample.记录编号 ?? '').trim()}@${String(sample.采样时间 ?? '').trim()}`
}

/** 数字统一保留三位小数后再展示，避免各处精度不一致。 */
export function formatNumber(value: number): string {
  return String(round3(value))
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
