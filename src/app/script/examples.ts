import { t } from '../i18n.ts';
import type { ScriptRecord } from './records.ts';
import { HEATMAP_SOURCE, VWAP_SOURCE } from './starter.ts';

/** Scripts to start from, written for this page: the two a page starts with first, then the others. */
export function examples(): { name: string; source: string; place?: ScriptRecord['place'] }[] {
  return [
    { name: t('VWAP with bands'), source: VWAP_SOURCE, place: 'map' },
    { name: t('Stochastic heat map'), source: HEATMAP_SOURCE },
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
