<template>
  <section class="page" data-module="sediment">
    <header class="page-head">
      <div>
        <h2>泥沙监测管理</h2>
        <p class="page-desc">维护泥沙监测记录，围绕记录编号、站点编号、采样时间、含沙量做登记、筛选与状态流转。零含沙量是有效实测值，不按缺测处理。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleEntryForm">补录泥沙样本</button>
        <button class="btn" type="button" @click="exportRows">导出泥沙监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form v-if="showEntryForm" class="panel" @submit.prevent="submitEntry">
      <h3>补录泥沙样本</h3>
      <p class="panel-desc">
        样本、级配与汇总整体保存，任何一步写不进去就都不写；同一站点同一采样时间只接受先入库的一份。
        颗粒级配统一写法：粒径:占比,…（占比合计 100%）。
      </p>
      <div class="form-grid">
        <label v-for="field in entryFields" :key="field.key" class="filter-item">
          <span>{{ field.label }}</span>
          <input v-model="entryForm[field.key]" :placeholder="field.placeholder" />
        </label>
      </div>
      <button class="btn primary" type="submit">保存补录样本</button>
      <button class="btn ghost" type="button" @click="toggleEntryForm">取消</button>
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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ cellText(row, column) }}</td>
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
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无泥沙监测数据，可先补录泥沙样本</td>
        </tr>
      </tbody>
    </table>

    <section v-if="selectedRow" class="panel">
      <h3>颗粒级配面板 · {{ selectedRow['记录编号'] }}</h3>
      <p class="panel-desc">
        站点 {{ selectedRow['站点编号'] }} · 原始采样时间 {{ originalTime(selectedRow) }} ·
        含沙量 {{ readingText(selectedRow['含沙量']) }} · 输沙率 {{ readingText(selectedRow['输沙率']) }}
      </p>
      <table v-if="gradationPanel.result" class="data-table">
        <thead>
          <tr><th>粒径(mm)</th><th>占比(%)</th><th>分级输沙率(kg/s)</th></tr>
        </thead>
        <tbody>
          <tr v-for="fraction in gradationPanel.result.fractions" :key="fraction.粒径">
            <td>{{ fraction.粒径 }}</td>
            <td>{{ fraction.占比 }}</td>
            <td>{{ fraction.分级输沙率 }}</td>
          </tr>
          <tr v-if="!gradationPanel.result.fractions.length">
            <td colspan="3" class="empty-state">颗粒级配缺测</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="error-text">{{ gradationPanel.error }}</p>
      <div class="filter-bar">
        <label class="filter-item">
          <span>改写输沙率</span>
          <input v-model="rateDraft" placeholder="不小于 0 的数值" />
        </label>
        <button class="btn" type="button" @click="submitRate">改写输沙率</button>
      </div>
    </section>

    <footer class="page-foot">
      <span>
        共 {{ total }} 条泥沙监测记录
        <template v-if="snapshot"> · 最近整体保存 {{ snapshot['汇总时间'] }}</template>
      </span>
      <span v-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
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
  computeGradation,
  lastSummarySnapshot,
  originalSampleTime,
  readingText,
  rewriteTransportRate,
  saveSedimentBundle,
  sedimentSummary,
  type GradationResult,
  type NewSampleInput,
} from '@/data/sediment-rules'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('sediment')
const columns = ["记录编号", "站点编号", "采样时间", "含沙量", "输沙率", "颗粒级配", "采样人", "记录状态"]
const actions = ["提交审核", "确认通过", "标记异常", "归档样本", "级配面板"]
const statuses = ["已采集", "待审核", "已通过", "异常值", "已归档"]
// 含沙量、输沙率、颗粒级配走共用的零值判定与展示写法
const readingColumns = new Set(["含沙量", "输沙率", "颗粒级配"])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const stats = ref<{ label: string; value: number }[]>([])
const snapshot = ref<EntryRow | null>(null)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const showEntryForm = ref(false)
const emptyEntryForm = (): NewSampleInput => ({
  站点编号: '',
  采样时间: '',
  含沙量: '',
  输沙率: '',
  颗粒级配: '',
  采样人: '',
})
const entryForm = ref<NewSampleInput>(emptyEntryForm())
const entryFields: { key: keyof NewSampleInput; label: string; placeholder: string }[] = [
  { key: '站点编号', label: '站点编号', placeholder: '如 STAT-0001' },
  { key: '采样时间', label: '采样时间', placeholder: 'YYYY-MM-DD HH:mm' },
  { key: '含沙量', label: '含沙量', placeholder: '0 为有效值，留空为缺测' },
  { key: '输沙率', label: '输沙率', placeholder: '0 为有效值，留空为缺测' },
  { key: '颗粒级配', label: '颗粒级配', placeholder: '0.05:30,0.25:50,1.0:20' },
  { key: '采样人', label: '采样人', placeholder: '采样人姓名' },
]

const selectedId = ref<number | null>(null)
const rateDraft = ref('')
const selectedRow = computed(
  () => rows.value.find((row) => Number(row.id) === selectedId.value) ?? null,
)
const gradationPanel = computed<{ result: GradationResult | null; error: string }>(() => {
  if (!selectedRow.value) return { result: null, error: '' }
  try {
    return { result: computeGradation(selectedRow.value), error: '' }
  } catch (error) {
    return { result: null, error: error instanceof Error ? error.message : '级配写法有误' }
  }
})

function cellText(row: EntryRow, column: string): string {
  if (readingColumns.has(column)) return readingText(row[column])
  const value = row[column]
  return value === undefined || value === null || value === '' ? '—' : String(value)
}

function originalTime(row: EntryRow): string {
  return originalSampleTime(row) || '—'
}

function toggleEntryForm() {
  showEntryForm.value = !showEntryForm.value
}

function submitEntry() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = saveSedimentBundle({ ...entryForm.value })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  entryForm.value = emptyEntryForm()
  showEntryForm.value = false
  reload()
}

function submitRate() {
  if (selectedId.value === null) return
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = rewriteTransportRate(selectedId.value, rateDraft.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
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
  noticeMessage.value = ''
  if (action === '归档样本') {
    const result = archiveSedimentSample(Number(row.id))
    if (result.ok) {
      noticeMessage.value = result.message
    } else {
      errorMessage.value = result.message
    }
    reload()
    return
  }
  if (action === '级配面板') {
    selectedId.value = Number(row.id)
    rateDraft.value = readingText(row['输沙率']) === '缺测' ? '' : String(row['输沙率'])
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    const summary = sedimentSummary()
    stats.value = [
      { label: '本月采样次数', value: summary.本月采样数 },
      { label: '缺测样本', value: summary.缺测数 },
      { label: '零含沙量样本', value: summary.零值数 },
      { label: '待审核记录', value: summary.待审核数 },
    ]
    snapshot.value = lastSummarySnapshot()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '泥沙监测列表读取失败'
  }
}

onMounted(reload)
</script>
