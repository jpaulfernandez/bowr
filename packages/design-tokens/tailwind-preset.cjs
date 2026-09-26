// Tailwind/NativeWind preset generated at load time from the canonical token file,
// so web and native values cannot drift from src/tokens.json.
const tokens = require('./src/tokens.json');

const px = (value) => `${value}px`;

module.exports = {
  theme: {
    colors: {
      transparent: 'transparent',
      ...Object.fromEntries(Object.entries(tokens.color).map(([name, value]) => [name, value.hex])),
    },
    spacing: {
      0: '0px',
      ...Object.fromEntries(Object.entries(tokens.space).map(([step, value]) => [step, px(value)])),
    },
    borderRadius: {
      none: '0px',
      full: '9999px',
      ...Object.fromEntries(Object.entries(tokens.radius).map(([name, value]) => [name, px(value)])),
    },
    fontFamily: { sans: [tokens.font.family] },
    fontSize: Object.fromEntries(
      Object.entries(tokens.font.size).map(([name, [size, lineHeight, weight]]) => [
        name,
        [px(size), { lineHeight: px(lineHeight), fontWeight: String(weight) }],
      ]),
    ),
    screens: {
      tablet: px(tokens.layout.breakpoints.tablet),
      desktop: px(tokens.layout.breakpoints.desktop),
    },
    extend: {
      minHeight: { target: px(tokens.layout.minTarget) },
      minWidth: { target: px(tokens.layout.minTarget) },
      maxWidth: { content: px(tokens.layout.contentMax), prose: '68ch' },
      width: { rail: px(tokens.layout.railWidth), 'rail-wide': px(tokens.layout.railWidthWide) },
    },
  },
};
