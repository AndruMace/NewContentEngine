const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: [number, string][] = [
  [1e9, 'billion'],
  [1e6, 'million'],
  [1e3, 'thousand'],
];

function under1000(n: number): string {
  const words: string[] = [];
  if (n >= 100) {
    words.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    words.push(n % 10 ? `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}` : TENS[Math.floor(n / 10)]);
  } else if (n > 0) words.push(ONES[n]);
  return words.join(' ');
}

/**
 * A whole number as spoken American English ("2110" → "two thousand one hundred ten"). TTS models
 * read bare digits unreliably (four-digit numbers come out as years), so narration spells them out.
 */
export function numberToWords(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Not a number: ${value}`);
  let n = Math.round(Math.abs(value));
  if (n === 0) return 'zero';
  const words: string[] = [];
  for (const [size, name] of SCALES) {
    if (n >= size) {
      words.push(`${under1000(Math.floor(n / size))} ${name}`);
      n %= size;
    }
  }
  if (n > 0) words.push(under1000(n));
  return (value < 0 ? 'minus ' : '') + words.join(' ');
}

/** Digits for the screen, with thousands separators. */
export const numberForScreen = (value: number) => Math.round(value).toLocaleString('en-US');
