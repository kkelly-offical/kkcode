import test from "node:test"
import assert from "node:assert/strict"
import {
  parseOsc11Response,
  isLightBackground,
  relativeLuminance,
  OSC11_QUERY
} from "../src/theme/background-probe.mjs"

/**
 * OSC 11 背景色探测的解析层。
 *
 * 样本里的 ESC 与 BEL 一律用 \u 转义写 —— 与被测模块同一条规矩。裸控制字符在
 * 测试文件里同样不可见，而「样本和实现被同一次复制粘贴弄错」是这类测试最典型的
 * 空转方式：两边一致地错，用例照绿。
 */

const ESC = "\u001b"
const BEL = "\u0007"
const ST = `${ESC}\\`

test("查询序列是完整可写的，不需要调用方再拼包头", () => {
  // 只导出 "]11;?" 的话，调用方得自己记得补 ESC 与终止符 —— 补错了终端不回答，
  // 而「不回答」与「答不出来」表现完全一样，没法排查。
  assert.equal(OSC11_QUERY, `${ESC}]11;?${BEL}`)
})

test("16 位分量的白色", () => {
  assert.deepEqual(parseOsc11Response(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`), { r: 255, g: 255, b: 255 })
})

test("8 位分量的深灰，ST 结尾", () => {
  assert.deepEqual(parseOsc11Response(`${ESC}]11;rgb:1e/1e/1e${ST}`), { r: 30, g: 30, b: 30 })
})

test("两种结尾都认", () => {
  const bel = parseOsc11Response(`${ESC}]11;rgb:fdfd/f6f6/e3e3${BEL}`)
  const st = parseOsc11Response(`${ESC}]11;rgb:fdfd/f6f6/e3e3${ST}`)
  assert.deepEqual(bel, { r: 253, g: 246, b: 227 })
  assert.deepEqual(st, bel, "BEL 与 ST 只是终止符不同，解析结果必须一致")
})

test("位宽不同但同一个颜色，归一化后必须相等", () => {
  // 这条挡的是「直接截前两位」：那样 rgb:ffff 会被读成 0xff（对），
  // 但 rgb:f/f/f 会被读成 0x0f（错到一半亮度）。
  const wide = parseOsc11Response(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`)
  const byte = parseOsc11Response(`${ESC}]11;rgb:ff/ff/ff${BEL}`)
  const nibble = parseOsc11Response(`${ESC}]11;rgb:f/f/f${BEL}`)
  assert.deepEqual(byte, wide)
  assert.deepEqual(nibble, wide)
  assert.deepEqual(parseOsc11Response(`${ESC}]11;rgb:000/000/000${BEL}`), { r: 0, g: 0, b: 0 })
})

test("12 位分量按位宽缩放，不是简单取高位", () => {
  // 0x800 / 0xfff = 0.50019… → 128
  assert.deepEqual(parseOsc11Response(`${ESC}]11;rgb:800/800/800${BEL}`), { r: 128, g: 128, b: 128 })
})

test("rgba 的第四个分量被忽略而不是让整条解析失败", () => {
  assert.deepEqual(parseOsc11Response(`${ESC}]11;rgba:1e1e/1e1e/1e1e/ffff${BEL}`), { r: 30, g: 30, b: 30 })
})

test("有的终端直接答 #rrggbb", () => {
  assert.deepEqual(parseOsc11Response(`${ESC}]11;#1e1e1e${BEL}`), { r: 30, g: 30, b: 30 })
  assert.deepEqual(parseOsc11Response(`${ESC}]11;#fdf6e3${ST}`), { r: 253, g: 246, b: 227 })
})

test("响应夹在别的输入中间也能取出来，两种结尾都要能定界", () => {
  // 解码链读到的往往是一大坨：用户按的键、别的应答、这条回复混在一起。
  // 两种终止符都要在这里试 —— 只有夹在中间时「包头正则认不认 ST」才看得出来：
  // 整条输入就是响应本身的话，把前后缀剥掉的兜底路径会把它救回来，
  // 于是 ST 支持从正则里掉了也照样绿。
  for (const terminator of [BEL, ST]) {
    const noisy = `abc${ESC}]11;rgb:2828/2c2c/3434${terminator}def`
    assert.deepEqual(parseOsc11Response(noisy), { r: 40, g: 44, b: 52 },
      `${terminator === BEL ? "BEL" : "ST"} 结尾的响应夹在中间时取不出来`)
  }
})

test("解码链已经把包头剥掉时，裸载荷也认", () => {
  assert.deepEqual(parseOsc11Response("rgb:1e/1e/1e"), { r: 30, g: 30, b: 30 })
  assert.deepEqual(parseOsc11Response(`rgb:1e/1e/1e${BEL}`), { r: 30, g: 30, b: 30 })
})

test("认不出来的一律 null，不是黑色", () => {
  // 返回 {0,0,0} 的话「探测失败」会被当成「背景是纯黑」——
  // 那是两件事：前者该回落默认，后者该判 dark 并且是确定的。
  const junk = [
    "",
    null,
    undefined,
    "hello",
    `${ESC}]11;rgb:zz/zz/zz${BEL}`,
    `${ESC}]11;rgb:1e/1e${BEL}`,
    `${ESC}]11;${BEL}`,
    `${ESC}]11;rgb:12345/1/1${BEL}`,
    "#12",
    `${ESC}]10;rgb:ffff/ffff/ffff${BEL}`   // OSC 10 是前景色，不是背景色
  ]
  for (const sample of junk) {
    assert.equal(parseOsc11Response(sample), null, `不该认: ${JSON.stringify(sample)}`)
  }
})

test("常见的深色与浅色背景判得对", () => {
  const parse = (hex) => parseOsc11Response(`${ESC}]11;#${hex}${BEL}`)
  assert.equal(isLightBackground(parse("1e1e1e")), false, "#1e1e1e（VS Code Dark）是深色")
  assert.equal(isLightBackground(parse("000000")), false)
  assert.equal(isLightBackground(parse("282c34")), false, "One Dark 是深色")
  assert.equal(isLightBackground(parse("fdf6e3")), true, "#fdf6e3（Solarized Light）是浅色")
  assert.equal(isLightBackground(parse("ffffff")), true)
  assert.equal(isLightBackground(parse("eeeeee")), true)
})

test("探测失败（null）回落深色", () => {
  assert.equal(isLightBackground(null), false)
  assert.equal(isLightBackground(undefined), false)
  assert.equal(isLightBackground(parseOsc11Response("完全不是响应")), false)
})

test("中灰按相对亮度判成深色，而且判定是稳定的", () => {
  // 伽马编码值直接加权的话，#767676 与 #808080 会分别落在阈值两侧 ——
  // 肉眼分不出的两个灰给出相反的主题，用户只会觉得「时好时坏」。
  assert.equal(isLightBackground({ r: 0x76, g: 0x76, b: 0x76 }), false)
  assert.equal(isLightBackground({ r: 0x80, g: 0x80, b: 0x80 }), false)
  assert.ok(relativeLuminance({ r: 128, g: 128, b: 128 }) < 0.25, "中灰的相对亮度约 0.216")
})

test("绿比蓝重：BT.709 的加权没有被写成简单平均", () => {
  const green = relativeLuminance({ r: 0, g: 255, b: 0 })
  const blue = relativeLuminance({ r: 0, g: 0, b: 255 })
  const red = relativeLuminance({ r: 255, g: 0, b: 0 })
  assert.ok(green > red && red > blue, `加权反了: 绿 ${green} 红 ${red} 蓝 ${blue}`)
  assert.equal(isLightBackground({ r: 0, g: 255, b: 0 }), true, "纯绿底该判浅色")
  assert.equal(isLightBackground({ r: 0, g: 0, b: 255 }), false, "纯蓝底该判深色")
})
