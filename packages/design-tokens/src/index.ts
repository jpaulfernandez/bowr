import tokens from './tokens.json';

export type ColorToken = keyof typeof tokens.color;

/** sRGB fallbacks for native rendering and tooling. */
export const colors = Object.fromEntries(
  Object.entries(tokens.color).map(([name, value]) => [name, value.hex]),
) as Record<ColorToken, string>;

export const space = tokens.space;
export const radius = tokens.radius;
export const font = tokens.font;
export const layout = tokens.layout;
export { tokens };
