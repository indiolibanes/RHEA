// Binary units, one rule everywhere: the unit follows the magnitude, the exact byte count stays available.
const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const exactFormat = new Intl.NumberFormat('pt-BR');

export function formatSize(value, { exact = false } = {}) {
  let bytes;
  try { bytes = BigInt(value); } catch { return ''; }
  if (bytes < 0n) return '';
  let unit = 0;
  let scaled = Number(bytes);
  while (scaled >= 1024 && unit < units.length - 1) { scaled /= 1024; unit += 1; }
  const human = unit === 0 ? exactFormat.format(bytes) + ' bytes' : decimal.format(scaled) + ' ' + units[unit];
  return exact && unit > 0 ? human + ' (' + exactFormat.format(bytes) + ' bytes)' : human;
}
