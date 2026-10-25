/**
 * Text as the voice should say it: units, symbols and abbreviations written out ("26,000 mph" →
 * "26,000 miles per hour", "1,460 °F" → "1,460 degrees Fahrenheit"). Captions keep the short forms;
 * only what the TTS reads goes through this. A unit is only expanded right after a number (in digits
 * or already spelled out), so ordinary words that look like units ("m", "in", "t") are left alone.
 */

/** A number just before a unit: digits ("26,000", "4.5") or a number already in words ("twelve"). */
const NUMBER =
  String.raw`(?:\d[\d,]*(?:\.\d+)?|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)(?:-(?:one|two|three|four|five|six|seven|eight|nine))?)`;

/** Unit → [singular, plural] as spoken. Longest first, so "km/h" wins over "km". */
const UNITS: [string, string, string][] = [
  ['km/h', 'kilometer per hour', 'kilometers per hour'],
  ['km/s', 'kilometer per second', 'kilometers per second'],
  ['m/s', 'meter per second', 'meters per second'],
  ['mph', 'mile per hour', 'miles per hour'],
  ['mi/s', 'mile per second', 'miles per second'],
  ['ft/s', 'foot per second', 'feet per second'],
  ['°C', 'degree Celsius', 'degrees Celsius'],
  ['°F', 'degree Fahrenheit', 'degrees Fahrenheit'],
  ['EJ', 'exajoule', 'exajoules'],
  ['PJ', 'petajoule', 'petajoules'],
  ['TJ', 'terajoule', 'terajoules'],
  ['GJ', 'gigajoule', 'gigajoules'],
  ['MJ', 'megajoule', 'megajoules'],
  ['kJ', 'kilojoule', 'kilojoules'],
  ['J', 'joule', 'joules'],
  ['kt', 'kiloton', 'kilotons'],
  ['Mt', 'megaton', 'megatons'],
  ['km', 'kilometer', 'kilometers'],
  ['cm', 'centimeter', 'centimeters'],
  ['mm', 'millimeter', 'millimeters'],
  ['m', 'meter', 'meters'],
  ['mi', 'mile', 'miles'],
  ['ft', 'foot', 'feet'],
  ['kg', 'kilogram', 'kilograms'],
  ['mg', 'milligram', 'milligrams'],
  ['lb', 'pound', 'pounds'],
  ['lbs', 'pound', 'pounds'],
  ['oz', 'ounce', 'ounces'],
  ['t', 'tonne', 'tonnes'],
  ['K', 'kelvin', 'kelvin'],
  ['%', 'percent', 'percent'],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const isOne = (n: string) => n === '1' || n === 'one';

// A unit ends at a word boundary, unless it ends in a symbol ("%", "°C").
const PATTERN = new RegExp(`(${NUMBER})\\s?(${UNITS.map(([u]) => escape(u)).sort((a, b) => b.length - a.length).join('|')})(?![\\w/])`, 'g');
const SPOKEN = new Map(UNITS.map(([u, one, many]) => [u, [one, many] as const]));

export function spokenText(text: string): string {
  return (
    text
      .replace(PATTERN, (_, n: string, unit: string) => {
        const [one, many] = SPOKEN.get(unit)!;
        return `${n} ${isOne(n) ? one : many}`;
      })
      // Grams only when it reads as a mass ("484 g of TNT"); a lone "g" after a number is g-force.
      .replace(new RegExp(`(${NUMBER})\\s?g(?= of\\b)`, 'g'), (_, n: string) => `${n} ${isOne(n) ? 'gram' : 'grams'}`)
      .replace(/°/g, ' degrees')
  );
}
