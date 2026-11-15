// The look plan, in one place: a sun-baked logistics depot at golden hour. Sand and clay
// walls, rust-red container steel, one teal accent for the defending team and one amber
// accent for the attackers. The same names are the CSS custom properties in index.html,
// so the HUD and the world never disagree about colour.
export const PALETTE = {
  canvas: '#2b2118', // warm dusk brown: the sky's low end and the page background
  sky: '#e8a558', // golden-hour horizon
  sand: '#c9a06b', // depot ground
  clay: '#a9805a', // adobe walls
  clayDark: '#7d5c3e', // shaded adobe, crate wood
  rust: '#9c4a2f', // container steel, attacker accent
  rustDark: '#6e3421',
  steel: '#5d6a72', // defender steel
  teal: '#2f8f83', // defender accent
  amber: '#f0a830', // attacker accent, warnings, the bomb light
  ink: '#f3ead9', // warm white: text, light colour
  muted: '#b8a88e', // secondary text
  hairline: '#4a3a28', // panel borders
  surface: '#33291d', // HUD panels
};

export function shade(name) {
  return PALETTE[name];
}
