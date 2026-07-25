/**
 * The same palette the web apps use, as plain values.
 *
 * React Native has no Tailwind, so the tokens are repeated here rather than shared — and that
 * duplication is deliberate rather than lazy. Extracting them into a package would mean a
 * build step between changing a colour and seeing it, for four constants that change roughly
 * never. If the palette starts moving, that is the moment to extract it.
 */
export const theme = {
  ink: '#12303A',
  tile: '#1B6E77',
  tileLight: '#3E939B',
  saffron: '#E3A02F',
  pomegranate: '#9C2A24',
  paper: '#F6F5F1',
  paperSunk: '#EDEBE4',
  slate: '#23262A',
  chalk: '#EDE8DA',
  chalkDim: '#A9A497',
  border: 'rgba(18,48,58,0.12)',
  muted: 'rgba(18,48,58,0.55)',
  faint: 'rgba(18,48,58,0.42)',
} as const;
