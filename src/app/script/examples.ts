import { t } from '../i18n.ts';
import type { ScriptRecord } from './records.ts';
import { HEATMAP_SOURCE, VWAP_SOURCE } from './starter.ts';

/** Scripts to start from, written for this page: the two a page starts with first, then the others. */
export function examples(): { name: string; source: string; place?: ScriptRecord['place'] }[] {
  return [
    { name: t('VWAP with bands'), source: VWAP_SOURCE, place: 'map' },
    { name: t('Stochastic heat map'), source: HEATMAP_SOURCE },
    // What each candle did to the range of the one before (inside, outside, up, down), and the patterns that follow from it (breakout,
    // failed break, rejection, engulfing) marked where they happen, with their levels and what the order flow did there when pointed at.
    { name: t('Bar patterns'), source: `// Bar patterns: what each candle did to the range of the candle before it, and the few patterns that follow from that,
// marked where they happen, with what the order flow did there.
//
// A candle can do four things to the range before it: stay inside it (in), go past both ends (out), or go past one
// end, the high (up) or the low (down). From that:
//   Breakout       a candle stayed inside the one before, and the next broke out of it: a quiet range gave way.
//   Failed break   a candle broke out of the one before, and the next took back the far end of that breakout candle:
//                  whoever followed the break is now on the wrong side of it.
//   Rejection      a candle went past the end before and closed back inside, with a long wick: the prices beyond were
//                  refused (the hammer and shooting star shapes).
//   Engulfing      a candle went past both ends and closed past one of them.
// Each pattern has a break level (the price it went through) and, where there is one, a next level: the far side of
// the range it is moving into. Point at a mark to read them, whether the next level was reached in that candle, what
// was bought and sold at market, the liquidations, the change in open interest, and where the hour's, day's, week's
// and month's opens stood. These describe what candles did. No test has shown that they say where price goes next.

showRange = option(type=checkbox, default=true, label="Mark inside and outside candles")
showAll = option(type=checkbox, default=false, label="Mark up and down candles too")
showPatterns = option(type=checkbox, default=true, label="Mark patterns")
showEveryFail = option(type=checkbox, default=false, label="Every failed break (frequent), not only after an inside or outside candle")
showLevels = option(type=checkbox, default=true, label="Draw the break and next levels")
showWaiting = option(type=checkbox, default=true, label="Show both break levels while the candle under way is inside")
paint = option(type=checkbox, default=false, label="Colour inside and outside candles")
sound = option(type=checkbox, default=false, label="Alert on a breakout or failed break in the candle under way")
upColor = option(type=color, default="rgb(0,170,140)", label="Up")
downColor = option(type=color, default="rgb(230,60,110)", label="Down")
insideColor = option(type=color, default="rgb(214,160,40)", label="Inside")
outsideColor = option(type=color, default="rgb(150,100,230)", label="Outside")

hi = $price.high
lo = $price.low
op = $price.open
cl = $price.close

// What this candle did to the range before it: 1 inside, 3 outside, 2 up, -2 down; 0 on the first, with nothing before it.
var first = renderer.length < 2
var tookHigh = !first && hi > hi[1]
var tookLow = !first && lo < lo[1]
move = first ? 0 : tookHigh && tookLow ? 3 : tookHigh ? 2 : tookLow ? -2 : 1
var IN = 1, OUT = 3, UP = 2, DOWN = -2

function group(s) {
  var parts = s.split(".")
  var w = parts[0], out = ""
  while (w.length > 3) { out = "," + w.slice(w.length - 3) + out; w = w.slice(0, w.length - 3) }
  return w + out + (parts.length > 1 ? "." + parts[1] : "")
}
function px(x) { return group(x.toFixed(x >= 1000 ? 0 : x >= 100 ? 1 : x >= 1 ? 2 : x >= 0.01 ? 4 : 6)) }
function usd(x) {
  var a = Math.abs(x)
  var s = a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : a >= 1e3 ? (a / 1e3).toFixed(0) + "K" : a.toFixed(0)
  return (x < 0 ? "-$" : "$") + s
}
function list(words) { return words.length < 2 ? words.join("") : words.slice(0, words.length - 1).join(", ") + " and " + words[words.length - 1] }

// The opens of the hour, day, week (from Monday) and month under way, in UTC, from the chart's own candles: known only
// once the chart reaches back to where that period began.
var days = Math.floor(time / 86400)
var dayStart = days * 86400
var weekStart = (days - (days + 3) % 7) * 86400
var date = new Date(time * 1000)
var monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000
var hourStart = Math.floor(time / 3600) * 3600
if (time == hourStart) { hOpen = op; hAt = hourStart }
if (time == dayStart) { dOpen = op; dAt = dayStart }
if (time == weekStart) { wOpen = op; wAt = weekStart }
if (time == monthStart) { mOpen = op; mAt = monthStart }

// Where a price stands against those opens.
function opens(price) {
  var over = [], under = [], unknown = []
  function one(name, open, at, start) {
    if (at != start) unknown.push(name)
    else if (price > open) over.push(name)
    else if (price < open) under.push(name)
  }
  if (renderer.timeframe <= 3600) one("hour", hOpen, hAt, hourStart)
  one("day", dOpen, dAt, dayStart)
  one("week", wOpen, wAt, weekStart)
  one("month", mOpen, mAt, monthStart)
  var lines = []
  if (over.length && !under.length && !unknown.length) lines.push("Above every open: the " + list(over) + " opens")
  else if (under.length && !over.length && !unknown.length) lines.push("Below every open: the " + list(under) + " opens")
  else {
    if (over.length) lines.push("Above the " + list(over) + " open" + (over.length > 1 ? "s" : ""))
    if (under.length) lines.push("Below the " + list(under) + " open" + (under.length > 1 ? "s" : ""))
  }
  if (unknown.length) lines.push("The chart does not reach back to the " + list(unknown) + " open" + (unknown.length > 1 ? "s" : ""))
  return lines.join("\\n")
}

// What was traded at market and liquidated in this candle, over the venues the flow column adds up, and the change in
// open interest over the venues the OI pane adds up.
function flow() {
  var out = []
  if (isNaN(vbuy) || isNaN(vsell)) out.push("Market orders were not recorded in this candle")
  else out.push((vbuy >= vsell ? "Buyers led by " : "Sellers led by ") + usd(Math.abs(vbuy - vsell)) + " (bought at market " + usd(vbuy) + ", sold " + usd(vsell) + ")")
  if (!isNaN(lbuy) && !isNaN(lsell)) out.push(lbuy > 0 || lsell > 0 ? "Liquidated: shorts " + usd(lbuy) + ", longs " + usd(lsell) : "No liquidations recorded")
  if (!isNaN(oichg)) out.push("Open interest " + (oichg >= 0 ? "rose by " + usd(oichg) + ": positions were opened" : "fell by " + usd(-oichg) + ": positions were closed"))
  return out.join("\\n")
}

// The pattern this candle completes upward (up = 1) or downward (up = 0), or null: its name, what happened, the level it
// went through, and the far side of the range it moves into (NaN where it has none).
var m1 = move[1], m2 = move[2]
var enough = renderer.length > 3
function pattern(up) {
  var dir = up ? UP : DOWN, against = up ? DOWN : UP
  var range = hi - lo, body = Math.abs(cl - op)
  var nearWick = up ? Math.min(op, cl) - lo : hi - Math.max(op, cl), farWick = up ? hi - Math.max(op, cl) : Math.min(op, cl) - lo
  // Past both ends of the candle before, and closed past one of them.
  if (move == OUT && (up ? cl > hi[1] : cl < lo[1])) return { name: "Engulfing", what: "It went past both ends of the candle before and closed " + (up ? "above its high (" + px(hi[1]) : "below its low (" + px(lo[1])) + ").", level: up ? lo[1] : hi[1], next: NaN, close: 1 }
  // Past the end before, closed back inside, with a long wick: the prices beyond were refused.
  if ((up ? tookLow : tookHigh) && (up ? cl > lo[1] : cl < hi[1]) && range > 0 && nearWick >= 2 * body && nearWick >= range / 2 && farWick <= range / 4)
    return { name: "Rejection", what: "It went " + (up ? "below the low (" + px(lo[1]) : "above the high (" + px(hi[1])) + ") of the candle before and closed back inside, with " + (up ? "a lower" : "an upper") + " wick " + (body > 0 ? (nearWick / body).toFixed(1) + " times its body" : "and almost no body") + " (the " + (up ? "hammer" : "shooting star") + " shape): the prices " + (up ? "below" : "above") + " were refused.", level: up ? hi : lo, next: NaN, close: 1 }
  if (move != dir) return null
  // The candle before stayed inside the one before it, and this one broke out of it.
  if (m1 == IN) return { name: "Breakout", what: "The candle before stayed inside the one before it; this one broke out of it " + (up ? "upward" : "downward") + (m2 == OUT ? ". The pause came right after an outside candle: a wide range, a quiet one, then this break." : m2 == dir ? ", the way candles were moving before the pause (a continuation)." : m2 == against ? ", against the way candles were moving before the pause (a reversal)." : "."), level: up ? hi[1] : lo[1], next: up ? hi[2] : lo[2], close: 0 }
  // The candle before broke out of the one before it, and this one took back its far end.
  if (m1 == against && (showEveryFail || m2 == IN || m2 == OUT)) return { name: "Failed break", what: "The candle before broke " + (up ? "below" : "above") + (m2 == IN ? " an inside candle (a pause)" : m2 == OUT ? " an outside candle" : " the one before it") + "; this one went back " + (up ? "above that breaking candle's high" : "below that breaking candle's low") + ", so the break failed and whoever followed it is on the wrong side.", level: up ? hi[1] : lo[1], next: up ? hi[2] : lo[2], close: 0 }
  return null
}

var found = null, up = 0
if (enough && showPatterns) { found = pattern(1); up = 1; if (!found) { found = pattern(0); up = 0 } }

breakAt = NaN
nextAt = NaN
if (found) {
  var c = up ? upColor : downColor
  var lines = [found.what]
  if (renderer.forming) lines.push("The candle is still under way: this can change.")
  if (!found.close) {
    lines.push("Break level " + px(found.level) + (isNaN(found.next) || found.next == found.level ? "" : " · next level " + px(found.next) + ", the far side of the range before"))
    if (!isNaN(found.next) && found.next != found.level) {
      var reached = up ? hi >= found.next : lo <= found.next
      lines.push((reached ? "Next level reached in this candle" : "Next level not reached in this candle, the furthest " + px(up ? hi : lo)) + (renderer.forming ? " so far" : ""))
    }
  } else if (found.name == "Rejection") lines.push("A later candle " + (up ? "above its high, " : "below its low, ") + px(found.level) + ", would follow through.")
  lines.push(flow())
  lines.push(opens(found.close ? cl : found.level))
  var sign = found.name + (up ? " ↑" : " ↓")
  // Below the candle's own word, or above the candle.
  if (up) mark({value: lo, text: sign, tip: lines.join("\\n"), color: c}, title="Pattern up", position=below, offset=14, shape=label)
  else mark({value: hi, text: sign, tip: lines.join("\\n"), color: c}, title="Pattern down", position=above, offset=2, shape=label)
  if (!found.close) { breakAt = found.level; nextAt = found.next == found.level ? NaN : found.next }
  if (sound && renderer.forming && !found.close) alert(sign + " at " + px(found.level), sound=up ? "rise" : "fall")
}

// A breakout's or failed break's levels, across its candle.
if (showLevels) {
  line({value: breakAt, color: up ? upColor : downColor}, title="Break level", lineType=1, lineStyle=2, lineWidth=1)
  line({value: nextAt, color: up ? upColor : downColor}, title="Next level", lineType=1, lineStyle=1, lineWidth=1)
}

// The candle under way, while it is inside the one before: the two levels it would break out at.
if (showWaiting && renderer.forming && move == IN && enough) {
  var says = "Inside the candle before so far: a breakout above " + px(hi[1]) + " or below " + px(lo[1]) + ".\\n" + flow()
  line(hi[1], title="Breakout up at", lineType=1, lineStyle=2, color=upColor)
  line(lo[1], title="Breakout down at", lineType=1, lineStyle=2, color=downColor)
  mark({value: hi[1], text: "waiting", tip: says, color: insideColor}, title="Inside so far", position=above, shape=text, size=0.9)
}

// Each candle's word under it: inside and outside, and up and down when asked for.
if (!first && ((showRange && (move == IN || move == OUT)) || showAll)) {
  var col = move == IN ? insideColor : move == OUT ? outsideColor : move == UP ? upColor : downColor
  var what = move == IN ? "Inside: it stayed within the high (" + px(hi[1]) + ") and the low (" + px(lo[1]) + ") of the candle before."
    : move == OUT ? "Outside: it went past both the high (" + px(hi[1]) + ") and the low (" + px(lo[1]) + ") of the candle before."
    : move == UP ? "Up: it went above the high of the candle before (" + px(hi[1]) + ") and held its low."
    : "Down: it went below the low of the candle before (" + px(lo[1]) + ") and held its high."
  mark({value: lo, text: move == IN ? "in" : move == OUT ? "out" : move == UP ? "up" : "dn", tip: what + (renderer.forming ? "\\nThe candle is still under way: this can change." : ""), color: col}, title="Candle", position=below, shape=text, size=0.85)
}

if (paint && move == IN) $price.color = insideColor
if (paint && move == OUT) $price.color = outsideColor
`, place: 'map' },
    // The volume-weighted prices of aggressive buyers and of aggressive sellers over the last candles, each with its band, on the map.
    { name: t('Buyer and seller VWAPs'), source: `// Buyer and seller VWAPs: the average price aggressive buyers paid (what was bought at market, weighted by its dollars)
// and the average price aggressive sellers got, over the last candles, each with a band one deviation wide. Where the
// buyers' line is above the sellers', buying came in at higher prices than selling; where it is below, selling led.

len = option(type=number, default=48, min=2, step=1, label="Window (candles)")
mult = option(type=number, default=1, min=0.1, step=0.1, label="Band width (deviations)")
buyColor = option(type=color, default="rgb(0,170,140)", label="Buyers")
sellColor = option(type=color, default="rgb(230,60,110)", label="Sellers")
buyFill = option(type=color, default="rgba(0,170,140,0.10)", label="Buyers' band")
sellFill = option(type=color, default="rgba(230,60,110,0.10)", label="Sellers' band")

var typical = ($price.high + $price.low + $price.close) / 3

var bought = sum(vbuy, len)
var buyers = sum(typical * vbuy, len) / bought
var buyersSpread = Math.sqrt(Math.max(0, sum(typical * typical * vbuy, len) / bought - buyers * buyers))

var sold = sum(vsell, len)
var sellers = sum(typical * vsell, len) / sold
var sellersSpread = Math.sqrt(Math.max(0, sum(typical * typical * vsell, len) / sold - sellers * sellers))

cloudarea(buyers - mult * buyersSpread, buyers + mult * buyersSpread, positiveColor=buyFill, negativeColor=buyFill, higherLineColor=buyFill, lowerLineColor=buyFill)
cloudarea(sellers - mult * sellersSpread, sellers + mult * sellersSpread, positiveColor=sellFill, negativeColor=sellFill, higherLineColor=sellFill, lowerLineColor=sellFill)
line(buyers, title="Buyers", color=buyColor, lineWidth=2)
line(sellers, title="Sellers", color=sellColor, lineWidth=2)
`, place: 'map' },
    // Liquidations as a cascade reads: shorts liquidated up, longs down, heights compressed so one cascade does not flatten the rest,
    // and each bar as bright as the candle's liquidations are unusual against the last candles; the line is the net pressure.
    { name: t('Liquidations'), source: `// Liquidations: shorts liquidated (forced buys) up in violet, longs liquidated (forced sells) down in amber. Heights are
// compressed so one cascade does not flatten every other bar. A bar is dim while the candle's liquidations are ordinary
// and burns to full as they become unusual against the last candles, so a cascade reads before you look at the axis.
// The line is the net pressure, brightening as it becomes unusual too.

compression = option(type=number, default=0.5, min=0.1, step=0.05, label="Height compression (1 = linear)")
win = option(type=number, default=72, min=10, step=1, label="Baseline window (candles)")
cascadeZ = option(type=number, default=2, min=0.5, step=0.1, label="Cascade at (deviations)")
pressureLen = option(type=number, default=21, min=1, step=1, label="Pressure smoothing (candles)")
dimAlpha = option(type=number, default=0.26, min=0.02, step=0.02, label="Quiet opacity")
showPressure = option(type=checkbox, default=true, label="Net pressure line")
markCandles = option(type=checkbox, default=false, label="Colour cascade candles")

var SHORT_RGB = "150,105,255"
var LONG_RGB = "255,196,64"
var PRESSURE_RGB = "130,130,150"

// A colour from a hue: at the quiet opacity while z is at or under 0, at full once it reaches the gate.
function heat(rgb, z, gate, floor) {
  var d = Math.min(1, Math.max(0, z) / Math.max(gate, Number.EPSILON))
  return "rgba(" + rgb + "," + (floor + (1 - floor) * d).toFixed(3) + ")"
}

// lbuy is the dollars of shorts liquidated in the candle (their positions were bought back), lsell the longs.
var shorts = lbuy
var longs = lsell
var up = Math.pow(shorts, compression)
var down = Math.pow(longs, compression)

// How unusual the candle's liquidations are: deviations from their average over the window.
var total = shorts + longs
var mean = sma(total, win)
var spread = Math.sqrt(Math.max(0, sma(total * total, win) - mean * mean))
var z = spread > Number.EPSILON ? (total - mean) / spread : 0

histogram({ time: time, value: up, color: heat(SHORT_RGB, z, cascadeZ, dimAlpha) }, title="Shorts liquidated")
histogram({ time: time, value: -down, color: heat(LONG_RGB, z, cascadeZ, dimAlpha) }, title="Longs liquidated")

var pressure = ema(up - down, pressureLen)
var pMean = sma(pressure, win)
var pSpread = Math.sqrt(Math.max(0, sma(pressure * pressure, win) - pMean * pMean))
var pZ = pSpread > Number.EPSILON ? Math.abs((pressure - pMean) / pSpread) : 0
if (showPressure) line({ time: time, value: pressure, color: heat(PRESSURE_RGB, pZ, 2, 0.3) }, title="Net pressure", lineWidth=2)

if (markCandles && z > cascadeZ) $price.color = shorts >= longs ? "rgb(150,105,255)" : "rgb(255,196,64)"
` },
    // Each candle's volume by the side that led it, dim while ordinary and bright when unusual, with a mark where its delta is unusual
    // too.
    { name: t('Volume anomalies'), source: `// Volume anomalies: each candle's volume, in the buy colour where more was bought at market and the sell colour where more
// was sold. A bar is dim while its volume is ordinary and bright when it is more than Threshold deviations above its average
// over the last candles. A grey bar marks a candle whose delta (bought less sold) is unusual in the same way.

length = option(type=number, default=72, min=5, step=1, label="Baseline window (candles)")
mult = option(type=number, default=2, min=0.5, step=0.1, label="Threshold (deviations)")
upColor = option(type=color, default="rgba(0,190,165,0.25)", label="Bought")
downColor = option(type=color, default="rgba(235,40,130,0.25)", label="Sold")
upBright = option(type=color, default="rgb(0,190,165)", label="Bought, unusual")
downBright = option(type=color, default="rgb(235,40,130)", label="Sold, unusual")
deltaColor = option(type=color, default="rgba(128,128,128,0.8)", label="Unusual delta")
showDelta = option(type=checkbox, default=true, label="Mark unusual delta")
colorCandles = option(type=checkbox, default=false, label="Colour unusual candles")

var volume = vbuy + vsell
var delta = vbuy - vsell
var bought = vbuy > vsell

// Unusual: more than mult deviations above the average over the window.
var vMean = sma(volume, length)
var vSpread = Math.sqrt(Math.max(0, sma(volume * volume, length) - vMean * vMean))
var unusual = volume > vMean + mult * vSpread
var size = Math.abs(delta)
var dMean = sma(size, length)
var dSpread = Math.sqrt(Math.max(0, sma(size * size, length) - dMean * dMean))

histogram({ time: time, value: volume, color: unusual ? (bought ? upBright : downBright) : (bought ? upColor : downColor) }, title="Volume")
if (showDelta && size > dMean + mult * dSpread) histogram({ time: time, value: size, color: deltaColor }, title="Delta")

if (colorCandles && unusual) $price.color = bought ? upBright : downBright
` },
    { name: t('Cumulative delta'), source: '// What was bought at market less what was sold, added up candle after candle.\nline(cum(vbuy - vsell), title=CVD)\n' },
    { name: t('Spot and perpetual CVD'), source: '// The cumulative delta of the spot markets and of the perpetuals, apart.\nspotColor = option(type=color, default=#2e9bff, label=Spot)\nperpColor = option(type=color, default=#ff9f1c, label=Perpetual)\nspotDelta = source(vbuy, type=spot) - source(vsell, type=spot)\nperpDelta = source(vbuy, type=perp) - source(vsell, type=perp)\nline(cum(spotDelta), title=Spot, color=spotColor)\nline(cum(perpDelta), title=Perp, color=perpColor, priceScaleId=perp)\n' },
    { name: t('Delta histogram'), source: '// Each candle\'s delta, in the buy colour where buyers led and the sell colour where sellers did.\nup = option(type=color, default=rgb(38,166,154), label=Buys)\ndown = option(type=color, default=rgb(239,83,80), label=Sells)\nvar delta = vbuy - vsell\nhistogram({ time: time, value: delta, color: delta > 0 ? up : down }, title=Delta)\n' },
    { name: t('Buy share'), source: '// The share of the volume bought at market over the last candles, in percent.\nlength = option(default=20, min=1, label=Candles)\nline(100 * sum(vbuy, length) / sum(vbuy + vsell, length), title="Buy share %")\nline(50, color=rgba(128,128,128,0.6), title=Even)\n' },
  ];
}

/** A row's height in the pane for an example (the heat map's sixteen rows need room). */
export const exampleHeight = (source: string): number | undefined => source === HEATMAP_SOURCE ? 160 : undefined;
