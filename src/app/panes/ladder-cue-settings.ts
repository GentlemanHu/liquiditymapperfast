/**
 * The order book's cues (`state.ladderCues`, the Cues button in the book's header): what lights when a venue's displayed depth changes, and the
 * heat strip under each venue's part of a level. Kept apart from the pane so the store can read it without the pane's weight.
 *
 * `look`: Wash lights the cell and runs a crest through it; Rim leaves the cell alone and lights its outer edge; Deposit shows the layer an
 * addition made and the crest of a decrease; Marks lights nothing and keeps only the signed marks beside the rows; Off draws nothing at all.
 * `sense`: how large a change must be to light a cell (Calm: only the largest; Lively: the smaller ones too).
 * `contact`: a market order that reached a venue's depth makes a quick ripple on that cell (the trade tape; large orders only).
 * `heat`: the strip under each cell, Added the share of the cell that is estimated recent net increase, Activity the recent change (adds
 * and removes) against the cell's size.
 */
export const CUE_LOOKS = ['off', 'wash', 'rim', 'deposit', 'marks'] as const;
export type CueLookSetting = (typeof CUE_LOOKS)[number];
export const HEAT_KINDS = ['off', 'added', 'activity'] as const;
export type HeatKind = (typeof HEAT_KINDS)[number];

export const SENSES = ['calm', 'normal', 'lively'] as const;
export type Sense = (typeof SENSES)[number];
/** The size (BTC-sized USD, scaled to the coin) at which a change is as strong as it gets, 1 - exp(-1) of the way: by sensitivity. */
export const SENSE_SCALE_USD: Readonly<Record<Sense, number>> = { calm: 3_500_000, normal: 1_500_000, lively: 700_000 };

export interface LadderCues { look: CueLookSetting; heat: HeatKind; contact: boolean; sense: Sense }

/** Everything on, as the page's new features are (the choice is one click away). A save that holds none gets these; an explicit Off is kept. */
export const LADDER_CUES_DEFAULT: LadderCues = { look: 'wash', heat: 'added', contact: true, sense: 'normal' };

/** The settings of a save or a layout, field by field: anything missing or not one of the choices gets its default. */
export function readLadderCues(raw: unknown): LadderCues {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    look: (CUE_LOOKS as readonly unknown[]).includes(o.look) ? o.look as CueLookSetting : LADDER_CUES_DEFAULT.look,
    heat: (HEAT_KINDS as readonly unknown[]).includes(o.heat) ? o.heat as HeatKind : LADDER_CUES_DEFAULT.heat,
    contact: typeof o.contact === 'boolean' ? o.contact : LADDER_CUES_DEFAULT.contact,
    sense: (SENSES as readonly unknown[]).includes(o.sense) ? o.sense as Sense : LADDER_CUES_DEFAULT.sense,
  };
}
