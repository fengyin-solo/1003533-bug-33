<template>
  <section class="page" data-module="sediment">
    <header class="page-head">
      <div>
        <h2>泥沙监测管理</h2>
        <p class="page-desc">维护泥沙监测记录，围绕记录编号、站点编号、采样时间、含沙量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleForm">
          {{ formOpen ? '收起登记表单' : '登记/补录泥沙样本' }}
        </button>
        <button class="btn" type="button" @click="exportRows">导出泥沙监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in summaryCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form v-if="formOpen" class="filter-bar sample-form" @submit.prevent="submitSample">
      <label v-for="field in sampleFields" :key="field.key" class="filter-item">
        <span>{{ field.label }}</span>
        <input v-model="sampleForm[field.key]" :placeholder="field.placeholder" />
      </label>
      <button class="btn primary" type="submit">保存样本</button>
      <button class="btn ghost" type="button" @click="toggleForm">取消</button>
      <p class="form-hint">含沙量留空表示缺测，填 0 表示实测零含沙量；级配格式如 0.062:18,0.125:42,0.25:68。</p>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>测定判定</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ cellText(row, column) }}</td>
          <td>
            <span class="verdict" :class="verdictClass(row)">{{ verdictText(row) }}</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openRewrite(row)">改写输沙率</button>
            <button
              v-if="row.archived !== true"
              class="link"
              type="button"
              @click="archiveRow(row)"
            >
              归档样本
            </button>
            <span v-else class="archived-tag">已归档</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无泥沙监测数据，可先登记泥沙监测记录</td>
        </tr>
      </tbody>
    </table>

    <form v-if="rewriteTarget" class="filter-bar rewrite-bar" @submit.prevent="submitRewrite">
      <span class="rewrite-label">
        改写样本 {{ rewriteTarget.记录编号 }} 的输沙率（采样时间 {{ rewriteTarget.采样时间 }} 保持不变）
      </span>
      <label class="filter-item">
        <span>流量(m³/s)</span>
        <input v-model="rewriteFlow" placeholder="输入新的流量" />
      </label>
      <button class="btn primary" type="submit">确认改写</button>
      <button class="btn ghost" type="button" @click="rewriteTarget = null">取消</button>
    </form>

    <section class="gradation-panel">
      <h3 class="panel-title">颗粒级配面板</h3>
      <div class="gradation-grid">
        <article v-for="item in panelItems" :key="item.id" class="gradation-card">
          <header class="gradation-head">
            <strong>{{ item.记录编号 }}</strong>
            <span class="verdict" :class="`verdict-${item.verdict}`">{{ item.verdict }}</span>
          </header>
          <p class="gradation-line">采样时间：{{ item.采样时间 }}</p>
          <template v-if="item.result">
            <p class="gradation-line">
              <span v-if="item.result.d16 !== null">d16={{ item.result.d16 }}mm　</span>
              <span v-if="item.result.d50 !== null">d50={{ item.result.d50 }}mm　</span>
              <span v-if="item.result.d84 !== null">d84={{ item.result.d84 }}mm　</span>
              <span v-if="item.result.meanDiameter !== null">平均粒径={{ item.result.meanDiameter }}mm</span>
            </p>
            <p class="gradation-line">
              级配曲线：<span v-for="point in item.result.points" :key="point.diameter" class="gradation-point">
                {{ point.diameter }}mm→{{ point.percentFiner }}%
              </span>
            </p>
          </template>
          <p v-else class="gradation-line">{{ item.resultText }}</p>
        </article>
        <p v-if="!panelItems.length" class="empty-state">暂无样本，保存样本后这里会展示级配计算结果</p>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条泥沙监测记录</span>
      <span v-if="notice" class="notice-text">{{ notice }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  archiveSedimentSample,
  gradationPanel,
  listSedimentSamples,
  rewriteSedimentDischarge,
  saveSedimentSample,
  sedimentSummary,
} from '@/api/sediment-service'
import {
  formatConcentration,
  formatDischarge,
  formatNumber,
  measurementVerdict,
} from '@/data/sediment-rules'
import type { GradationPanelItem, SedimentSampleInput } from '@/api/sediment-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('sediment')
const columns = ["记录编号", "站点编号", "采样时间", "含沙量", "输沙率", "颗粒级配", "采样人", "记录状态"]
const actions = ["提交审核", "确认通过", "标记异常"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]

const sampleFields: { key: keyof SedimentSampleInput; label: string; placeholder: string }[] = [
  { key: '记录编号', label: '记录编号', placeholder: '如 SEDI-0004' },
  { key: '站点编号', label: '站点编号', placeholder: '如 STAT-0001' },
  { key: '采样时间', label: '采样时间', placeholder: '2026-10-03 08:30' },
  { key: '含沙量', label: '含沙量(kg/m³)', placeholder: '留空为缺测，0 为实测零值' },
  { key: '流量', label: '流量(m³/s)', placeholder: '用于计算输沙率' },
  { key: '颗粒级配', label: '颗粒级配', placeholder: '粒径:累计百分数，逗号分隔' },
  { key: '采样人', label: '采样人', placeholder: '采样人姓名' },
]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const notice = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const formOpen = ref(false)
const sampleForm = ref<SedimentSampleInput>(emptySampleForm())
const rewriteTarget = ref<EntryRow | null>(null)
const rewriteFlow = ref('')
const panelItems = ref<GradationPanelItem[]>([])
const summary = ref(sedimentSummary())

const summaryCards = computed(() => [
  { label: '样本总数', value: summary.value.total },
  { label: '有效样本（含零值）', value: summary.value.valid },
  { label: '零含沙量样本', value: summary.value.zero },
  { label: '缺测样本', value: summary.value.missing },
  {
    label: '平均含沙量(kg/m³)',
    value: summary.value.avgConcentration === null ? '—' : formatNumber(summary.value.avgConcentration),
  },
  {
    label: '合计输沙率(kg/s)',
    value: summary.value.totalDischarge === null ? '—' : formatNumber(summary.value.totalDischarge),
  },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function emptySampleForm(): SedimentSampleInput {
  return { 记录编号: '', 站点编号: '', 采样时间: '', 含沙量: '', 流量: '', 颗粒级配: '', 采样人: '' }
}

function cellText(row: EntryRow, column: string): string {
  if (column === '含沙量') {
    return formatConcentration(row.含沙量)
  }
  if (column === '输沙率') {
    return formatDischarge(row.输沙率)
  }
  return String(row[column] ?? '—')
}

function verdictText(row: EntryRow): string {
  return measurementVerdict(row.含沙量)
}

function verdictClass(row: EntryRow): string {
  return `verdict-${measurementVerdict(row.含沙量)}`
}

function toggleForm() {
  formOpen.value = !formOpen.value
  if (formOpen.value) {
    sampleForm.value = emptySampleForm()
    sampleForm.value.记录编号 = `SEDI-${String(listSedimentSamples().length + 1).padStart(4, '0')}`
    sampleForm.value.采样时间 = defaultSampleTime()
  }
}

function defaultSampleTime(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function submitSample() {
  errorMessage.value = ''
  notice.value = ''
  const result = saveSedimentSample(sampleForm.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  notice.value = result.message
  formOpen.value = false
  reload()
}

function openRewrite(row: EntryRow) {
  rewriteTarget.value = row
  rewriteFlow.value = row.流量 === undefined ? '' : String(row.流量)
}

function submitRewrite() {
  if (!rewriteTarget.value) {
    return
  }
  errorMessage.value = ''
  notice.value = ''
  const result = rewriteSedimentDischarge(Number(rewriteTarget.value.id), rewriteFlow.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  notice.value = result.message
  rewriteTarget.value = null
  reload()
}

function archiveRow(row: EntryRow) {
  errorMessage.value = ''
  notice.value = ''
  const result = archiveSedimentSample(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  notice.value = result.message
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    panelItems.value = gradationPanel()
    summary.value = sedimentSummary()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '泥沙监测列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.sample-form,
.rewrite-bar {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.form-hint {
  flex-basis: 100%;
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.rewrite-label {
  font-size: 13px;
  color: var(--muted);
}
.verdict {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  background: #eef2f7;
}
.verdict-零含沙量 {
  background: #e0f2fe;
  color: #0369a1;
}
.verdict-缺测 {
  background: #fee2e2;
  color: #b42318;
}
.archived-tag {
  color: var(--muted);
  font-size: 12px;
}
.gradation-panel {
  margin-top: 16px;
}
.panel-title {
  margin: 0 0 8px;
  font-size: 15px;
}
.gradation-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.gradation-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.gradation-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.gradation-line {
  margin: 2px 0;
  font-size: 12px;
  color: var(--muted);
}
.gradation-point {
  display: inline-block;
  margin-right: 8px;
}
.notice-text {
  color: #067647;
}
</style>
