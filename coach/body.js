// Measurements and the body-fat estimate (spec §9). Lengths are stored in inches.

export const SITES = [
  { key: 'waist', label: 'Waist', landmark: 'At the navel, relaxed, after a normal exhale' },
  { key: 'neck', label: 'Neck', landmark: 'Just below the larynx' },
  { key: 'chest', label: 'Chest', landmark: 'Nipple line, arms down, relaxed' },
  { key: 'arm', label: 'Arm', landmark: 'Mid upper arm, relaxed, same side each week' },
  { key: 'thigh', label: 'Thigh', landmark: 'Midway between hip crease and top of kneecap, same side' },
];

export const IN_TO_CM = 2.54;

// Two readings per site, averaged. One reading is used as-is; none -> null.
export function averageReadings(readings) {
  const vals = (readings || []).filter((v) => Number.isFinite(v) && v > 0);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

export function siteAverages(readingsBySite) {
  const out = {};
  for (const { key } of SITES) out[key] = averageReadings(readingsBySite[key]);
  return out;
}

// US Navy circumference formula, men (inches). Trend only: ±3–4 % absolute error.
export function navyBodyFat({ waist, neck, heightIn }) {
  if (!(waist > 0 && neck > 0 && heightIn > 0) || waist <= neck) return null;
  const bf = 86.010 * Math.log10(waist - neck) - 70.041 * Math.log10(heightIn) + 36.76;
  return Math.round(bf * 10) / 10;
}
