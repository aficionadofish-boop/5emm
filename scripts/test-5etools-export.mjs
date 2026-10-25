// Test the 5etools export against what betteR20 will make of it.
//
// For every preset in src/data/templates/monsters: load it into the running dev app
// (window.__loadMonster), export it (window.__render5etools), render each action with
// 5etools' own Renderer, clean the HTML the way betteR20 does (getCleanText) and parse it
// with betteR20's attack regexes (betterR20 js/5etools-importer.js, _baseAddAction).
// The official Monster Manual block goes through the same pipeline; the two are compared.
//
// usage: node scripts/test-5etools-export.mjs <5etools-2014-src dir> [app url]
//   the 5etools dir needs js/ and data/bestiary/bestiary-mm.json
//   app url defaults to http://localhost:9124/5emm/#/ (NO_OPEN=1 npx quasar dev --port 9124)
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9334
const FIVETOOLS = resolve(process.argv[2] ?? '')
const APP = process.argv[3] ?? 'http://localhost:9124/5emm/#/'
const PRESETS = resolve('src/data/templates/monsters')

// differences from the MM that are not the exporter's doing
const KNOWN = {
  'Aboleth/Tentacle': 'preset has reach 5 (MM 10)',
  'Ancient Green Dragon/Bite': 'preset reach 10 (MM 15)',
  'Ancient Green Dragon/Claw': 'preset reach 5 (MM 10)',
  'Ancient Green Dragon/Tail': 'preset reach 10 (MM 20)',
  'Basilisk/Bite': 'preset reach 10 (MM 5)',
  'Azer/Warhammer':
    'on purpose: extra damage is written before the two-handed alternative, so betteR20 rolls the fire damage (the MM order makes it roll the versatile die instead)',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = mkdtempSync(join(tmpdir(), '5et-test-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${tmp}`,
    '--allow-file-access-from-files',
    '--no-first-run',
    'about:blank',
  ],
  { stdio: 'ignore' }
)

let wsUrl
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200)
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json())
      .webSocketDebuggerUrl
  } catch {}
}
const ws = new WebSocket(wsUrl)
await new Promise((r) => (ws.onopen = r))
let nextId = 1
const pending = new Map()
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
const send = (method, params = {}, sessionId) =>
  new Promise((res) => {
    const id = nextId++
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })

async function openPage(url) {
  const {
    result: { targetId },
  } = await send('Target.createTarget', { url: 'about:blank' })
  const {
    result: { sessionId },
  } = await send('Target.attachToTarget', { targetId, flatten: true })
  const evaluate = async (expression) => {
    const r = await send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    )
    if (r.result?.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800))
    }
    return r.result?.result?.value
  }
  await send('Page.enable', {}, sessionId)
  await send('Page.navigate', { url }, sessionId)
  return evaluate
}

async function waitFor(evaluate, expression, what) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression).catch(() => false)) return
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}`)
}

try {
  // 1. export every preset from the app
  const app = await openPage(APP)
  await waitFor(app, 'typeof window.__loadMonster === "function"', 'the app')
  const exported = {}
  for (const file of readdirSync(PRESETS).filter((f) => f.endsWith('.5emm.json'))) {
    const data = readFileSync(join(PRESETS, file), 'utf-8')
    await app(`window.__loadMonster(${data})`)
    await sleep(150)
    exported[file.replace('.5emm.json', '')] = JSON.parse(
      await app('window.__render5etools()')
    ).monster[0]
  }

  // 2. a page with 5etools' renderer
  const html = join(tmp, 'render.html')
  const js = (f) => pathToFileURL(join(FIVETOOLS, 'js', f)).href
  writeFileSync(
    html,
    // render.js only asks utils-config.js (an ES module) for the style: 2014 = "classic"
    `<!doctype html><meta charset="utf-8"><script>globalThis.VetoolsConfig = { get: () => 'classic' }</script>${['parser.js', 'utils.js', 'render.js']
      .map((f) => `<script src="${js(f)}"></script>`)
      .join('')}`
  )
  const r5 = await openPage(pathToFileURL(html).href)
  await waitFor(r5, 'typeof Renderer === "function"', '5etools render.js')

  // betteR20's getCleanText + _baseAddAction parsing, in the page
  await r5(`window.parseActions = (actions) => (actions || []).map((action) => {
    const clean = (str) => {
      if (!str || !str.trim()) return ''
      const d = document.createElement('div'); d.innerHTML = str
      d.querySelectorAll('td, th').forEach((e) => e.append(' | '))
      d.querySelectorAll('tr').forEach((e) => e.append('\\n'))
      d.querySelectorAll('p, li, br').forEach((e) => e.append('\\n\\n'))
      d.querySelectorAll('li').forEach((e) => e.prepend(' - '))
      return d.textContent.trim().replace(/\\n/g, '<<N>>').replace(/\\s+/g, ' ')
        .replace(/<<N>>(<<N>>)+/g, '\\n\\n').replace(/<<N>>/g, '\\n').replace(/\\n +/g, '\\n')
    }
    const renderer = new Renderer()
    const text = clean(renderer.render({ entries: action.entries }, 1)).replace(/^\\s*Hit:\\s*/, '')
    const out = { name: clean(renderer.render(action.name)), text }
    if (!/ (Weapon|Spell) Attack:/.test(text)) return out
    const melee = text.split(/ (?:Weapon|Spell) Attack:/)[0].includes('Melee')
    out.range = ((melee ? text.match(/reach (.*?),/) : text.match(/range (.*?),/)) || ['', ''])[1]
    out.toHit = (text.match(/\\+(.*?) to hit/) || ['', ''])[1]
    const re = /\\d+ \\((\\d+d\\d+\\s?(?:\\+|-)?\\s?\\d*)\\) (\\S+ )?damage/g
    let m = re.exec(text)
    if (m) {
      out.damage = m[1]; out.type = (m[2] || '').trim()
      m = re.exec(text)
      if (m) { out.damage2 = m[1]; out.type2 = (m[2] || '').trim() }
    }
    return out
  })`)

  // 3. compare with the Monster Manual
  const mm = JSON.parse(
    readFileSync(join(FIVETOOLS, 'data', 'bestiary', 'bestiary-mm.json'), 'utf-8')
  ).monster
  const norm = (s) => (s || '').replace(/\s+/g, '')
  let problems = 0
  for (const [name, ours] of Object.entries(exported)) {
    const official = mm.find((m) => m.name === name)
    const oursParsed = await r5(`parseActions(${JSON.stringify(ours.action)})`)
    console.log(`\n== ${name}${official ? '' : ' (not in MM: export checked alone)'}`)
    const head = (m) =>
      `AC ${JSON.stringify(m.ac?.[0]?.ac ?? m.ac?.[0])} HP ${m.hp?.average} (${m.hp?.formula}) CR ${
        m.cr?.cr ?? m.cr
      } passive ${m.passive}`
    console.log(`   ours: ${head(ours)}`)
    if (official) console.log(`   MM:   ${head(official)}`)
    const offParsed = official
      ? await r5(`parseActions(${JSON.stringify(official.action)})`)
      : []
    for (const a of oursParsed) {
      if (a.toHit === undefined) {
        if (/attack/i.test(a.text) && /to hit/i.test(a.text)) {
          problems++
          console.log(`   !! ${a.name}: reads like an attack but betteR20 won't parse it: ${a.text}`)
        }
        continue
      }
      const o = offParsed.find((x) => x.name.toLowerCase() === a.name.toLowerCase())
      const ours = `+${a.toHit} ${a.range} | ${a.damage} ${a.type}${a.damage2 ? ` + ${a.damage2} ${a.type2}` : ''}`
      if (!a.damage) {
        problems++
        console.log(`   !! ${a.name}: no damage parsed: ${a.text}`)
      } else if (!o) {
        console.log(`   ok ${a.name}: ${ours} (no MM action of that name)`)
      } else {
        const theirs = `+${o.toHit} ${o.range} | ${o.damage} ${o.type}${o.damage2 ? ` + ${o.damage2} ${o.type2}` : ''}`
        const same = norm(ours) === norm(theirs)
        const known = KNOWN[`${name}/${a.name}`]
        if (!same && !known) problems++
        console.log(
          `   ${same ? 'ok' : known ? '~~' : '!!'} ${a.name}: ${ours}${
            same ? '' : `   MM: ${theirs}${known ? `   (known: ${known})` : ''}`
          }`
        )
      }
    }
    // the whole stat block must render in 5etools without throwing
    await r5(`new Renderer().render({entries: [${JSON.stringify(ours)}].flatMap((m) => [
      ...(m.trait||[]), ...(m.action||[]), ...(m.bonus||[]), ...(m.reaction||[]), ...(m.legendary||[]),
      ...(m.spellcasting||[]).map((s) => ({type: 'entries', name: s.name, entries: s.headerEntries}))
    ].map((e) => ({type: 'entries', name: e.name, entries: e.entries || []})))})`)
  }
  writeFileSync(join(tmp, 'exported.json'), JSON.stringify(exported, null, 2))
  console.log(`\n${problems} problem(s). Exports: ${join(tmp, 'exported.json')}`)
  process.exitCode = problems ? 1 : 0
} finally {
  ws.close()
  chrome.kill()
}
