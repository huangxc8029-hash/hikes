const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

// 坡度图算法与网页版 app/js/app.js 的 slopeBands() 是同一套口径；
// 这些断言锁的是"小程序和网页版给出同样的颜色、同样的段"。
function loadTs(relativePath) {
  const file = path.join(__dirname, relativePath)
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 }
  }).outputText
  const mod = new Module(file)
  mod.filename = file
  mod.paths = module.paths
  mod._compile(compiled, file)
  return mod.exports
}

const { slopeSeries, slopeBandOf, slopeText, slopeColumns } = loadTs('../src/services/slope.ts')

test('坡度分档：≤15% 缓、15–25% 中、>25% 陡', () => {
  assert.equal(slopeBandOf(8).level, 'easy')
  assert.equal(slopeBandOf(15).level, 'easy')
  assert.equal(slopeBandOf(18).level, 'mid')
  assert.equal(slopeBandOf(25).level, 'mid')
  assert.equal(slopeBandOf(31).level, 'hard')
  assert.equal(slopeText('easy'), '缓')
  assert.equal(slopeText('mid'), '中')
  assert.equal(slopeText('hard'), '陡')
})

test('持续陡坡整段判为一档，不会碎成噪点', () => {
  // 2 km、每 100 m 升 40 m（约 40%）→ 整条都是 >25%
  const profile = Array.from({ length: 21 }, (_, i) => 500 + i * 40)
  const series = slopeSeries({ km: 2, elevationM: profile })
  assert.equal(series.bands.length, 1)
  assert.equal(series.bands[0].level, 'hard')
  assert.ok(series.bands[0].pct > 25)
  assert.equal(Math.round(series.bands[0].fromKm), 0)
  assert.equal(Math.round(series.bands[0].toKm), 2)
})

test('平路与缓坡落在缓档', () => {
  const profile = Array.from({ length: 21 }, (_, i) => 500 + i * 5)   // 5%
  const series = slopeSeries({ km: 2, elevationM: profile })
  assert.equal(series.bands.length, 1)
  assert.equal(series.bands[0].level, 'easy')
})

test('下坡的陡也是陡：方向不抵消', () => {
  const down = Array.from({ length: 21 }, (_, i) => 900 - i * 40)
  const series = slopeSeries({ km: 2, elevationM: down })
  assert.equal(series.bands[0].level, 'hard')
})

test('没有海拔数据时退回 profile，并标出是估算', () => {
  const series = slopeSeries({ km: 1, profile: [0, 0.02, 0.05, 0.09] })
  assert.equal(series.hasElevation, false)
  assert.equal(series.profile.length, 4)
  assert.ok(series.bands.length >= 1)
})

test('数据不足两点时不画图，也不瞎编段', () => {
  assert.deepEqual(slopeSeries({ km: 5, elevationM: [100] }).bands, [])
  assert.deepEqual(slopeSeries({ km: null, elevationM: [100, 200] }).bands, [])
  assert.deepEqual(slopeColumns(slopeSeries({ km: 5, elevationM: [100] })), [])
})

test('柱状图列数受剖面点数限制，且都在 0–100% 区间内', () => {
  const profile = Array.from({ length: 10 }, (_, i) => 500 + i * 10)
  const columns = slopeColumns(slopeSeries({ km: 3, elevationM: profile }), 72)
  assert.equal(columns.length, 9)
  columns.forEach(col => {
    assert.ok(col.leftPct >= 0 && col.leftPct < 100)
    assert.ok(col.widthPct > 0)
    assert.ok(col.heightPct >= 4 && col.heightPct <= 100)
  })
})
