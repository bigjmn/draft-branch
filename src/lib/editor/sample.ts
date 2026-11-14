import type { Draft, ElementType } from "./types";

const sample: [ElementType, string][] = [
  ["scene", "EXT. COASTAL ROAD - DUSK"],
  [
    "action",
    "The last of the daylight hangs over the water. A narrow road cuts through the cliffs, empty except for a faded blue station wagon.",
  ],
  [
    "action",
    "Inside, a map unfolds across the passenger seat. Someone has circled a town at the very edge of the paper.",
  ],
  ["scene", "INT. STATION WAGON - CONTINUOUS"],
  [
    "action",
    "ELLA, 32, drives with the window down. Her younger brother, BEN, studies the map as if it might change its mind.",
  ],
  ["character", "BEN"],
  ["dialogue", "You know there's a faster way."],
  ["character", "ELLA"],
  ["dialogue", "I know."],
  ["parenthetical", "(a beat)"],
  ["dialogue", "That's not why we're here."],
  [
    "action",
    "Ben looks out at the sea. On the horizon, a lighthouse blinks once. Then darkness.",
  ],
  ["character", "BEN"],
  ["dialogue", "You think he still keeps it on?"],
  [
    "action",
    "Ella doesn't answer. She turns the radio down, although nothing is playing.",
  ],
  ["transition", "CUT TO:"],
  ["scene", "EXT. LIGHTHOUSE - NIGHT"],
  [
    "action",
    "A porch light warms the steps of a weather-beaten house. Beyond it, the lighthouse rises into the fog.",
  ],
  [
    "action",
    "Ella stops at the gate. A handwritten sign reads: BACK BEFORE DARK.",
  ],
  ["character", "ELLA"],
  ["parenthetical", "(to herself)"],
  ["dialogue", "You're late."],
  ["action", "From somewhere inside, a kettle begins to whistle."],
];

export function createSampleDraft(): Draft {
  return {
    title: "The Last Light",
    blocks: sample.map(([type, text], index) => ({
      id: "sample-" + index,
      type,
      text,
    })),
  };
}
