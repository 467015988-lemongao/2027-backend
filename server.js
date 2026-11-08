import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

// 活动档位定义
const ACTIVITY_TYPES = {
  A200: { id: 'A200', label: '满200送50', threshold: 200, bonus: 50 },
  A300: { id: 'A300', label: '满300送100', threshold: 300, bonus: 100 }
}

const DATA_DIR = path.join(__dirname, 'data')
const DATA_FILE = path.join(DATA_DIR, 'signups.json')

// 初始化数据文件
function initDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ signups: [] }, null, 2))
}

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'))
  } catch (err) {
    // 数据文件缺失或损坏时兜底返回空数据，记录日志便于排查
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      tag: 'DATA',
      event: 'LOAD_FAILED',
      error: err.message,
      file: DATA_FILE
    }))
    return { signups: [] }
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
}

initDataFile()

app.use(cors())
app.use(express.json())
// 统计后端页面
app.use(express.static(path.join(__dirname, 'public')))

// 手机号脱敏：138****1234
function maskPhone(phone) {
  return phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
}

// 姓名脱敏：张* / 王*明
function maskName(name) {
  if (name.length <= 1) return name
  if (name.length === 2) return name[0] + '*'
  return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1]
}

// 请求级结构化日志：tag 标识接口，event 标识关键分支，
// costMs 为从进入 handler 到打日志时刻的耗时，单行 JSON 输出便于线上采集检索
function createReqLogger(tag) {
  const start = Date.now()
  return (event, extra = {}) => {
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      tag,
      event,
      costMs: Date.now() - start,
      ...extra
    }))
  }
}

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true, server: 'newyear-2027-server', time: new Date().toISOString() })
})

// 活动档位信息
app.get('/api/activities', (req, res) => {
  res.json({ activities: Object.values(ACTIVITY_TYPES) })
})

// 报名
app.post('/api/signup', (req, res) => {
  const log = createReqLogger('SIGNUP')
  const { name, phone, activityType } = req.body || {}
  // 入口日志：手机号脱敏；若后续无任何出口日志，说明 handler 中途异常退出
  log('REQ', { phone: maskPhone((phone || '').trim()), activityType: activityType || null })

  const errors = {}
  const trimmedName = (name || '').trim()
  if (!trimmedName) errors.name = '请输入姓名'
  else if (trimmedName.length > 20) errors.name = '姓名不能超过20个字符'

  const trimmedPhone = (phone || '').trim()
  if (!trimmedPhone) errors.phone = '请输入手机号'
  else if (!/^1[3-9]\d{9}$/.test(trimmedPhone)) errors.phone = '请输入正确的11位手机号'

  if (!ACTIVITY_TYPES[activityType]) errors.activityType = '请选择活动档位'

  // 分支：参数校验失败
  if (Object.keys(errors).length > 0) {
    log('PARAM_INVALID', { errors })
    return res.status(400).json({ ok: false, errors, message: '报名信息有误，请检查后重试' })
  }

  const data = loadData()
  // 分支：手机号重复报名
  if (data.signups.some(s => s.phone === trimmedPhone)) {
    log('DUPLICATE_PHONE', { phone: maskPhone(trimmedPhone), activityType })
    return res.status(409).json({ ok: false, message: '该手机号已报名，无需重复报名' })
  }

  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: trimmedName,
    phone: trimmedPhone,
    activityType,
    createdAt: new Date().toISOString()
  }
  data.signups.push(record)
  saveData(data)
  // 分支：报名成功（含落库后的总人数，便于观察数据增长）
  log('SUCCESS', {
    id: record.id,
    phone: maskPhone(trimmedPhone),
    activityType,
    totalSignups: data.signups.length
  })

  res.json({
    ok: true,
    message: '报名成功',
    data: {
      activityLabel: ACTIVITY_TYPES[activityType].label,
      createdAt: record.createdAt
    }
  })
})

// 按服务器本地时区取日期（YYYY-MM-DD），与统计页展示时间一致
function localDate(iso) {
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 统计：按日期分组的各档位报名人数 + 汇总
app.get('/api/stats', (req, res) => {
  const log = createReqLogger('STATS')
  const data = loadData()
  const byDate = {}
  const byType = { A200: 0, A300: 0 }

  for (const s of data.signups) {
    const date = localDate(s.createdAt)
    if (!byDate[date]) byDate[date] = { date, A200: 0, A300: 0, total: 0 }
    if (byDate[date][s.activityType] === undefined) byDate[date][s.activityType] = 0
    byDate[date][s.activityType]++
    byDate[date].total++
    if (byType[s.activityType] !== undefined) byType[s.activityType]++
  }

  const daily = Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date))
  // 出口日志：汇总人数与日期维度，costMs 主要反映读文件+聚合耗时
  log('OK', { total: data.signups.length, byType, days: daily.length })

  res.json({
    ok: true,
    total: data.signups.length,
    byType,
    daily
  })
})

// 报名明细（脱敏）
app.get('/api/records', (req, res) => {
  const data = loadData()
  const records = [...data.signups]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200)
    .map(s => ({
      id: s.id,
      name: maskName(s.name),
      phone: maskPhone(s.phone),
      activityType: s.activityType,
      activityLabel: ACTIVITY_TYPES[s.activityType]?.label || s.activityType,
      createdAt: s.createdAt
    }))
  res.json({ ok: true, count: data.signups.length, records })
})

app.listen(PORT, () => {
  console.log(`2027元旦活动后端服务已启动: http://localhost:${PORT}`)
  console.log(`统计页面: http://localhost:${PORT}/admin.html`)
})
