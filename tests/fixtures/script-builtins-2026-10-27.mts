import { createHash } from 'node:crypto';
import { filterKey, type BarInputs, type SourceInputs } from '../../src/app/script/inputs.ts';
import type { ScriptResult } from '../../src/app/script/protocol.ts';
import type { OptionValue } from '../../src/app/script/records.ts';

/*
 * The built-in scripts (the two a page starts with, then the examples) as they were on 2026-10-27, frozen here with candles to run them over
 * and a digest of everything a run gives back. `script-outputs.test.mts` pins the digests the interpreter gave before it was made faster, so
 * a change that should only make it faster cannot change a value, a colour, a style, a warning or a step; the examples themselves may change
 * later without moving it.
 */

/** A script read once and run as often as its inputs change (`createRunner`, of the build under test or another). */
export type MakeRunner = (id: string, source: string, options: Record<string, OptionValue>, now?: () => number) => { run(inputs: BarInputs): ScriptResult; readonly startedAt: number };

export const BUILTIN_SCRIPTS: readonly { name: string; variants: readonly Record<string, OptionValue>[]; source: string }[] = [
  {
    name: "VWAP with bands", variants: [{}],
    source: "// VWAP with bands: the volume-weighted average of the typical price, (high + low + close) / 3, over the last candles.\n// It rolls with the candles (it is not anchored to a session), and its bands are that price's deviation around it.\n\n// option(...) is a setting: change it under the text, no need to edit the script.\nlen = option(type=number, default=48, min=4, step=1, label=\"Window (candles)\")\nmult = option(type=number, default=1.8, min=0.2, step=0.1, label=\"Band width (deviations)\")\nmidColor = option(type=color, default=\"rgba(255,64,255,0.95)\", label=\"VWAP\")\nbandColor = option(type=color, default=\"rgba(255,64,255,0.6)\", label=\"Bands\")\n\n// A var is worked out again on every candle. vbuy and vsell are the dollars bought and sold at market in the candle.\nvar typical = ($price.high + $price.low + $price.close) / 3\nvar vol = vbuy + vsell\nvar num = sma(typical * vol, len)\nvar den = sma(vol, len)\nvar num2 = sma(typical * typical * vol, len)\n\n// A name set without var keeps its value from candle to candle: mid[1] would be the VWAP one candle back.\n// Where the flow was not recorded, vbuy reads NaN: with no volume to weigh by, the lines leave a gap there.\nmid = den > 0 ? num / den : NaN\nvar sd = Math.sqrt(Math.max(0, num2 / den - mid * mid))\nupper = mid + mult * sd\nlower = mid - mult * sd\n\nline(mid, title=\"VWAP\", color=midColor, lineWidth=2)\nline(upper, title=\"+SD\", color=bandColor)\nline(lower, title=\"-SD\", color=bandColor)\n",
  },
  {
    name: "Stochastic heat map", variants: [{}, { scale: 2, colorCandles: true }],
    source: "// Stochastic heat map: the stochastic of the close (where it stands between the lowest low and the highest high of the\n// last candles, 0 to 100) over sixteen windows, from 4 candles in the bottom row to 210 in the top one. Each row is a colour:\n// warm near the top of its range, cool near the bottom. Rows that agree make a band of one colour; the line is their average.\n\nscale = option(type=number, default=1, min=0.25, step=0.25, label=\"Window scale\")\nsmooth = option(type=number, default=3, min=1, step=1, label=\"Smoothing (candles)\")\nlowColor = option(type=color, default=\"rgb(41,121,255)\", label=\"Low\")\nmidColor = option(type=color, default=\"rgba(128,128,128,0.12)\", label=\"Middle\")\nhighColor = option(type=color, default=\"rgb(255,152,0)\", label=\"High\")\nlineColor = option(type=color, default=\"rgb(213,0,249)\", label=\"Average\")\nshowAverage = option(type=checkbox, default=true, label=\"Average line\")\ncolorCandles = option(type=checkbox, default=false, label=\"Colour the candles\")\n\n// A function of your own: the colour of a reading from 0 to 100, from Low through Middle to High.\nfunction shade(k) {\n  return interpolate(k / 100, lowColor, midColor, highColor)\n}\n\n// One smoothed stochastic per window. Each call of stoch or ema keeps its own history, which is why there are sixteen lines\n// and not a loop: in a loop every window would share one.\nvar c = $price.close\nvar h = $price.high\nvar l = $price.low\nvar k1 = ema(stoch(c, h, l, 4 * scale), smooth)\nvar k2 = ema(stoch(c, h, l, 5 * scale), smooth)\nvar k3 = ema(stoch(c, h, l, 7 * scale), smooth)\nvar k4 = ema(stoch(c, h, l, 9 * scale), smooth)\nvar k5 = ema(stoch(c, h, l, 12 * scale), smooth)\nvar k6 = ema(stoch(c, h, l, 15 * scale), smooth)\nvar k7 = ema(stoch(c, h, l, 20 * scale), smooth)\nvar k8 = ema(stoch(c, h, l, 26 * scale), smooth)\nvar k9 = ema(stoch(c, h, l, 34 * scale), smooth)\nvar k10 = ema(stoch(c, h, l, 44 * scale), smooth)\nvar k11 = ema(stoch(c, h, l, 57 * scale), smooth)\nvar k12 = ema(stoch(c, h, l, 74 * scale), smooth)\nvar k13 = ema(stoch(c, h, l, 96 * scale), smooth)\nvar k14 = ema(stoch(c, h, l, 125 * scale), smooth)\nvar k15 = ema(stoch(c, h, l, 162 * scale), smooth)\nvar k16 = ema(stoch(c, h, l, 210 * scale), smooth)\n\n// The rows, on a scale of 0 to 100 (each 6.25 high), so the average line stands at its own value over them.\nbrokenarea({ time: time, lowerValue: 0, higherValue: 6.25, color: shade(k1) })\nbrokenarea({ time: time, lowerValue: 6.25, higherValue: 12.5, color: shade(k2) })\nbrokenarea({ time: time, lowerValue: 12.5, higherValue: 18.75, color: shade(k3) })\nbrokenarea({ time: time, lowerValue: 18.75, higherValue: 25, color: shade(k4) })\nbrokenarea({ time: time, lowerValue: 25, higherValue: 31.25, color: shade(k5) })\nbrokenarea({ time: time, lowerValue: 31.25, higherValue: 37.5, color: shade(k6) })\nbrokenarea({ time: time, lowerValue: 37.5, higherValue: 43.75, color: shade(k7) })\nbrokenarea({ time: time, lowerValue: 43.75, higherValue: 50, color: shade(k8) })\nbrokenarea({ time: time, lowerValue: 50, higherValue: 56.25, color: shade(k9) })\nbrokenarea({ time: time, lowerValue: 56.25, higherValue: 62.5, color: shade(k10) })\nbrokenarea({ time: time, lowerValue: 62.5, higherValue: 68.75, color: shade(k11) })\nbrokenarea({ time: time, lowerValue: 68.75, higherValue: 75, color: shade(k12) })\nbrokenarea({ time: time, lowerValue: 75, higherValue: 81.25, color: shade(k13) })\nbrokenarea({ time: time, lowerValue: 81.25, higherValue: 87.5, color: shade(k14) })\nbrokenarea({ time: time, lowerValue: 87.5, higherValue: 93.75, color: shade(k15) })\nbrokenarea({ time: time, lowerValue: 93.75, higherValue: 100, color: shade(k16) })\n\nvar average = (k1 + k2 + k3 + k4 + k5 + k6 + k7 + k8 + k9 + k10 + k11 + k12 + k13 + k14 + k15 + k16) / 16\nif (showAverage) line(average, title=\"Average\", color=lineColor, lineWidth=2)\n\n// $price.color colours the map's candle: here by the average, when switched on.\nif (colorCandles) $price.color = shade(average)\n",
  },
  {
    name: "Buyer and seller VWAPs", variants: [{}],
    source: "// Buyer and seller VWAPs: the average price aggressive buyers paid (what was bought at market, weighted by its dollars)\n// and the average price aggressive sellers got, over the last candles, each with a band one deviation wide. Where the\n// buyers' line is above the sellers', buying came in at higher prices than selling; where it is below, selling led.\n\nlen = option(type=number, default=48, min=2, step=1, label=\"Window (candles)\")\nmult = option(type=number, default=1, min=0.1, step=0.1, label=\"Band width (deviations)\")\nbuyColor = option(type=color, default=\"rgb(0,170,140)\", label=\"Buyers\")\nsellColor = option(type=color, default=\"rgb(230,60,110)\", label=\"Sellers\")\nbuyFill = option(type=color, default=\"rgba(0,170,140,0.10)\", label=\"Buyers' band\")\nsellFill = option(type=color, default=\"rgba(230,60,110,0.10)\", label=\"Sellers' band\")\n\nvar typical = ($price.high + $price.low + $price.close) / 3\n\nvar bought = sum(vbuy, len)\nvar buyers = sum(typical * vbuy, len) / bought\nvar buyersSpread = Math.sqrt(Math.max(0, sum(typical * typical * vbuy, len) / bought - buyers * buyers))\n\nvar sold = sum(vsell, len)\nvar sellers = sum(typical * vsell, len) / sold\nvar sellersSpread = Math.sqrt(Math.max(0, sum(typical * typical * vsell, len) / sold - sellers * sellers))\n\ncloudarea(buyers - mult * buyersSpread, buyers + mult * buyersSpread, positiveColor=buyFill, negativeColor=buyFill, higherLineColor=buyFill, lowerLineColor=buyFill)\ncloudarea(sellers - mult * sellersSpread, sellers + mult * sellersSpread, positiveColor=sellFill, negativeColor=sellFill, higherLineColor=sellFill, lowerLineColor=sellFill)\nline(buyers, title=\"Buyers\", color=buyColor, lineWidth=2)\nline(sellers, title=\"Sellers\", color=sellColor, lineWidth=2)\n",
  },
  {
    name: "Liquidations", variants: [{}, { markCandles: true }],
    source: "// Liquidations: shorts liquidated (forced buys) up in violet, longs liquidated (forced sells) down in amber. Heights are\n// compressed so one cascade does not flatten every other bar. A bar is dim while the candle's liquidations are ordinary\n// and burns to full as they become unusual against the last candles, so a cascade reads before you look at the axis.\n// The line is the net pressure, brightening as it becomes unusual too.\n\ncompression = option(type=number, default=0.5, min=0.1, step=0.05, label=\"Height compression (1 = linear)\")\nwin = option(type=number, default=72, min=10, step=1, label=\"Baseline window (candles)\")\ncascadeZ = option(type=number, default=2, min=0.5, step=0.1, label=\"Cascade at (deviations)\")\npressureLen = option(type=number, default=21, min=1, step=1, label=\"Pressure smoothing (candles)\")\ndimAlpha = option(type=number, default=0.26, min=0.02, step=0.02, label=\"Quiet opacity\")\nshowPressure = option(type=checkbox, default=true, label=\"Net pressure line\")\nmarkCandles = option(type=checkbox, default=false, label=\"Colour cascade candles\")\n\nvar SHORT_RGB = \"150,105,255\"\nvar LONG_RGB = \"255,196,64\"\nvar PRESSURE_RGB = \"130,130,150\"\n\n// A colour from a hue: at the quiet opacity while z is at or under 0, at full once it reaches the gate.\nfunction heat(rgb, z, gate, floor) {\n  var d = Math.min(1, Math.max(0, z) / Math.max(gate, Number.EPSILON))\n  return \"rgba(\" + rgb + \",\" + (floor + (1 - floor) * d).toFixed(3) + \")\"\n}\n\n// lbuy is the dollars of shorts liquidated in the candle (their positions were bought back), lsell the longs.\nvar shorts = lbuy\nvar longs = lsell\nvar up = Math.pow(shorts, compression)\nvar down = Math.pow(longs, compression)\n\n// How unusual the candle's liquidations are: deviations from their average over the window.\nvar total = shorts + longs\nvar mean = sma(total, win)\nvar spread = Math.sqrt(Math.max(0, sma(total * total, win) - mean * mean))\nvar z = spread > Number.EPSILON ? (total - mean) / spread : 0\n\nhistogram({ time: time, value: up, color: heat(SHORT_RGB, z, cascadeZ, dimAlpha) }, title=\"Shorts liquidated\")\nhistogram({ time: time, value: -down, color: heat(LONG_RGB, z, cascadeZ, dimAlpha) }, title=\"Longs liquidated\")\n\nvar pressure = ema(up - down, pressureLen)\nvar pMean = sma(pressure, win)\nvar pSpread = Math.sqrt(Math.max(0, sma(pressure * pressure, win) - pMean * pMean))\nvar pZ = pSpread > Number.EPSILON ? Math.abs((pressure - pMean) / pSpread) : 0\nif (showPressure) line({ time: time, value: pressure, color: heat(PRESSURE_RGB, pZ, 2, 0.3) }, title=\"Net pressure\", lineWidth=2)\n\nif (markCandles && z > cascadeZ) $price.color = shorts >= longs ? \"rgb(150,105,255)\" : \"rgb(255,196,64)\"\n",
  },
  {
    name: "Volume anomalies", variants: [{}, { colorCandles: true, showDelta: false }],
    source: "// Volume anomalies: each candle's volume, in the buy colour where more was bought at market and the sell colour where more\n// was sold. A bar is dim while its volume is ordinary and bright when it is more than Threshold deviations above its average\n// over the last candles. A grey bar marks a candle whose delta (bought less sold) is unusual in the same way.\n\nlength = option(type=number, default=72, min=5, step=1, label=\"Baseline window (candles)\")\nmult = option(type=number, default=2, min=0.5, step=0.1, label=\"Threshold (deviations)\")\nupColor = option(type=color, default=\"rgba(0,190,165,0.25)\", label=\"Bought\")\ndownColor = option(type=color, default=\"rgba(235,40,130,0.25)\", label=\"Sold\")\nupBright = option(type=color, default=\"rgb(0,190,165)\", label=\"Bought, unusual\")\ndownBright = option(type=color, default=\"rgb(235,40,130)\", label=\"Sold, unusual\")\ndeltaColor = option(type=color, default=\"rgba(128,128,128,0.8)\", label=\"Unusual delta\")\nshowDelta = option(type=checkbox, default=true, label=\"Mark unusual delta\")\ncolorCandles = option(type=checkbox, default=false, label=\"Colour unusual candles\")\n\nvar volume = vbuy + vsell\nvar delta = vbuy - vsell\nvar bought = vbuy > vsell\n\n// Unusual: more than mult deviations above the average over the window.\nvar vMean = sma(volume, length)\nvar vSpread = Math.sqrt(Math.max(0, sma(volume * volume, length) - vMean * vMean))\nvar unusual = volume > vMean + mult * vSpread\nvar size = Math.abs(delta)\nvar dMean = sma(size, length)\nvar dSpread = Math.sqrt(Math.max(0, sma(size * size, length) - dMean * dMean))\n\nhistogram({ time: time, value: volume, color: unusual ? (bought ? upBright : downBright) : (bought ? upColor : downColor) }, title=\"Volume\")\nif (showDelta && size > dMean + mult * dSpread) histogram({ time: time, value: size, color: deltaColor }, title=\"Delta\")\n\nif (colorCandles && unusual) $price.color = bought ? upBright : downBright\n",
  },
  {
    name: "Cumulative delta", variants: [{}],
    source: "// What was bought at market less what was sold, added up candle after candle.\nline(cum(vbuy - vsell), title=CVD)\n",
  },
  {
    name: "Spot and perpetual CVD", variants: [{}],
    source: "// The cumulative delta of the spot markets and of the perpetuals, apart.\nspotColor = option(type=color, default=#2e9bff, label=Spot)\nperpColor = option(type=color, default=#ff9f1c, label=Perpetual)\nspotDelta = source(vbuy, type=spot) - source(vsell, type=spot)\nperpDelta = source(vbuy, type=perp) - source(vsell, type=perp)\nline(cum(spotDelta), title=Spot, color=spotColor)\nline(cum(perpDelta), title=Perp, color=perpColor, priceScaleId=perp)\n",
  },
  {
    name: "Delta histogram", variants: [{}],
    source: "// Each candle's delta, in the buy colour where buyers led and the sell colour where sellers did.\nup = option(type=color, default=rgb(38,166,154), label=Buys)\ndown = option(type=color, default=rgb(239,83,80), label=Sells)\nvar delta = vbuy - vsell\nhistogram({ time: time, value: delta, color: delta > 0 ? up : down }, title=Delta)\n",
  },
  {
    name: "Buy share", variants: [{}],
    source: "// The share of the volume bought at market over the last candles, in percent.\nlength = option(default=20, min=1, label=Candles)\nline(100 * sum(vbuy, length) / sum(vbuy + vsell, length), title=\"Buy share %\")\nline(50, color=rgba(128,128,128,0.6), title=Even)\n",
  },
]

const MINUTE = 60_000, HOUR = 3_600_000, LONGEST = 1_000;

/**
 * Candles of a wandering price with flow and liquidations on every set of markets the scripts read, the same first candles at every length:
 * some candles without flow (not recorded) and a short run without prices, as a page meets them.
 */
const series = ((): { close: number[]; high: number[]; low: number[]; flows: number[][][] } => {
  let seed = 4242;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const close: number[] = [], high: number[] = [], low: number[] = [];
  let p = 80_000;
  for (let i = 0; i < LONGEST; i++) { p *= 1 + (rnd() - 0.5) * 0.01; close.push(p); high.push(p * (1 + 0.004 * rnd())); low.push(p * (1 - 0.004 * rnd())); }
  const flows = [0, 1, 2].map(() => [0, 1, 2, 3].map(k => Array.from({ length: LONGEST }, () => k < 2 ? rnd() * 2e8 : rnd() < 0.3 ? rnd() * 5e6 : 0)));
  return { close, high, low, flows };
})();

export function candles(n: number, tf: number): BarInputs {
  const noFlow = (i: number): boolean => i % 97 === 13 || (i >= 300 && i < 306);
  const noPrice = (i: number): boolean => i >= 450 && i < 453;
  const price = (list: number[]): Float64Array => Float64Array.from({ length: n }, (_, i) => noPrice(i) ? NaN : list[i]!);
  const flow = (k: number): SourceInputs => {
    const [vbuy, vsell, lbuy, lsell] = series.flows[k]!.map(list => Float64Array.from({ length: n }, (_, i) => noFlow(i) ? NaN : list[i]!));
    return { vbuy: vbuy!, vsell: vsell!, lbuy: lbuy!, lsell: lsell!, markets: 4 };
  };
  return {
    tf, time: Float64Array.from({ length: n }, (_, i) => 1_790_000_000_000 + i * tf),
    open: price(series.close.map((c, i) => i ? series.close[i - 1]! : c)), high: price(series.high), low: price(series.low), close: price(series.close),
    volume: Float64Array.from({ length: n }, () => 1),
    sources: { '': flow(0), [filterKey({ kinds: ['perp'] })]: flow(1), [filterKey({ kinds: ['spot'] })]: flow(2) },
    forming: true,
  };
}

/** Everything a run gives back but its time, as text: each number exactly (-0 apart from 0), NaN as NaN. */
function resultText(r: ScriptResult): string {
  if (!r.ok) return `error ${JSON.stringify(r.error)}`;
  const nums = (f: Float64Array): string => Array.from(f, v => Object.is(v, -0) ? '-0' : String(v)).join(',');
  const plots = r.plots.map(p => `${p.kind}|${p.title}|${JSON.stringify(p.style)}|${Object.entries(p.fields).map(([k, f]) => `${k}:${nums(f)}`).join('|')}|${JSON.stringify(p.colors)}`);
  return `${plots.join('\n')}\n${JSON.stringify(r.candleColors ?? null)}\n${JSON.stringify(r.warnings)}\nsteps ${r.steps}`;
}

/**
 * A digest for each built-in and each set of options: every candle run from the first (500 one-minute candles, then 900 hourly ones), the
 * candle under way changed (only it runs again), and a candle closed with a new one begun (the run starts from what was held at the close).
 */
export function builtinDigests(make: MakeRunner): Record<string, string> {
  const now = (): number => 1_790_000_000_000;
  const out: Record<string, string> = {};
  for (const s of BUILTIN_SCRIPTS) for (const options of s.variants) {
    const h = createHash('sha256');
    h.update(resultText(make('x', s.source, options, now).run(candles(500, MINUTE))));
    const runner = make('x', s.source, options, now);
    h.update(resultText(runner.run(candles(900, HOUR))));
    const moved = candles(900, HOUR);
    moved.close[899] = moved.close[899]! * 1.001; moved.high[899] = Math.max(moved.high[899]!, moved.close[899]!);
    h.update(`${resultText(runner.run(moved))}\nfrom ${runner.startedAt}`);
    h.update(`${resultText(runner.run(candles(901, HOUR)))}\nfrom ${runner.startedAt}`);
    out[`${s.name}${Object.keys(options).length ? ` ${JSON.stringify(options)}` : ''}`] = h.digest('hex').slice(0, 32);
  }
  return out;
}
