#!/usr/bin/env node

const baseUrl = process.env.POINTAGE_BASE_URL?.trim() || 'http://localhost:3000'
const username = process.env.POINTAGE_TEST_USERNAME?.trim() || ''
const password = process.env.POINTAGE_TEST_PASSWORD?.trim() || ''
const taskId = Number(process.env.POINTAGE_TEST_TASK_ID || '')

if (!username || !password || !Number.isInteger(taskId) || taskId <= 0) {
  console.error(
    [
      'Missing test env vars.',
      'Required: POINTAGE_TEST_USERNAME, POINTAGE_TEST_PASSWORD, POINTAGE_TEST_TASK_ID',
      'Optional: POINTAGE_BASE_URL (default: http://localhost:3000)',
    ].join('\n')
  )
  process.exit(1)
}

const jar = new Map()

function updateCookies(response) {
  const header = response.headers.get('set-cookie')
  if (!header) return
  for (const part of header.split(',')) {
    const cookiePair = part.split(';')[0]?.trim()
    if (!cookiePair || !cookiePair.includes('=')) continue
    const [name, ...valueParts] = cookiePair.split('=')
    jar.set(name, valueParts.join('='))
  }
}

function cookieHeader() {
  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

async function api(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(jar.size > 0 ? { Cookie: cookieHeader() } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
  updateCookies(response)
  const data = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, data }
}

function assert(condition, message, payload = null) {
  if (condition) return
  console.error(`FAIL: ${message}`)
  if (payload !== null) {
    console.error(JSON.stringify(payload, null, 2))
  }
  process.exit(1)
}

function todayDateStamp() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

async function run() {
  const pointageDate = todayDateStamp()
  console.log(`Running pointage API integration flow on ${baseUrl}`)
  console.log(`Date: ${pointageDate}, taskId: ${taskId}`)

  const login = await api('/api/auth/login', { username, password })
  assert(login.ok, 'login failed', login)
  console.log('OK login')

  const start = await api('/api/pointage/start', {
    taskId,
    pointageDate,
    freeTaskLabel: null,
  })
  assert(start.ok, 'start failed', start)
  assert(typeof start.data.id_session_pointage === 'number', 'missing session id from start', start)
  const sessionId = start.data.id_session_pointage
  console.log(`OK start (sessionId=${sessionId}, existing=${Boolean(start.data.existing_active)})`)

  const heartbeat = await api('/api/pointage/heartbeat', {})
  assert(heartbeat.ok, 'heartbeat failed', heartbeat)
  assert(typeof heartbeat.data.active_session_id === 'number', 'heartbeat has no active session', heartbeat)
  console.log('OK heartbeat')

  const pause = await api('/api/pointage/pause', { sessionId })
  assert(pause.ok, 'pause failed', pause)
  assert(typeof pause.data.id_pause_pointage === 'number', 'missing pause id', pause)
  const pauseId = pause.data.id_pause_pointage
  console.log(`OK pause (pauseId=${pauseId})`)

  const resume = await api('/api/pointage/resume', {
    pauseId,
    pauseComment: 'integration-test resume',
  })
  assert(resume.ok, 'resume failed', resume)
  console.log('OK resume')

  const stop = await api('/api/pointage/stop', {
    sessionId,
    pauseId: null,
    sessionComment: 'integration-test stop',
    pauseComment: null,
  })
  assert(stop.ok, 'stop failed', stop)
  console.log('OK stop')

  const validate = await api('/api/pointage/validate', { pointageDate })
  assert(validate.ok, 'validate failed', validate)
  assert(typeof validate.data.validatedCount === 'number', 'validate count missing', validate)
  console.log(`OK validate (count=${validate.data.validatedCount})`)

  const logout = await api('/api/auth/logout', {})
  assert(logout.ok, 'logout failed', logout)
  console.log('OK logout')

  console.log('PASS: pointage API integration flow completed.')
}

run().catch((error) => {
  console.error('FAIL: unexpected error')
  console.error(error)
  process.exit(1)
})

