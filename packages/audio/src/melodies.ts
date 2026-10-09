import { generatedMelody, parseSteps, type Melody } from '@sim/engine';

/**
 * Melody library. Every entry is our own transcription of a public-domain composition
 * (composer died 70+ years ago, published before 1929), so both the work and the
 * transcription are free of copyright. Do not add transcriptions copied from MIDI sites.
 */

const defs: (Omit<Melody, 'steps'> & { src: string })[] = [
  {
    id: 'ode-to-joy',
    title: 'Ode to Joy',
    composer: 'Ludwig van Beethoven',
    license: 'public-domain',
    src: `E5+C4 E5 F5 G5 G5+B3 F5 E5 D5 C5+A3 C5 D5 E5 E5+G3 D5 D5
          E5+C4 E5 F5 G5 G5+B3 F5 E5 D5 C5+A3 C5 D5 E5 D5+G3 C5 C5
          D5+G3 D5 E5 C5 D5 E5 F5 E5 C5 D5 E5 F5 E5 D5 C5 D5 G4
          E5+C4 E5 F5 G5 G5+B3 F5 E5 D5 C5+A3 C5 D5 E5 D5+G3 C5 C5`,
  },
  {
    id: 'fur-elise',
    title: 'Für Elise',
    composer: 'Ludwig van Beethoven',
    license: 'public-domain',
    src: `E5 D#5 E5 D#5 E5 B4 D5 C5 A4+A2 C4 E4 A4 B4+E2 E4 G#4 B4 C5+A2
          E4 E5 D#5 E5 D#5 E5 B4 D5 C5 A4+A2 C4 E4 A4 B4+E2 E4 C5 B4 A4+A2
          E5 D#5 E5 D#5 E5 B4 D5 C5 A4+A2 C4 E4 A4 B4+E2 E4 G#4 B4 C5+A2
          E4 E5 D#5 E5 D#5 E5 B4 D5 C5 A4+A2 C4 E4 A4 B4+E2 E4 C5 B4 A4+A2
          B4 C5 D5 E5+C3 G4 F5 E5 D5+G2 F4 E5 D5 C5+A2 E4 D5 C5 B4+E2`,
  },
  {
    id: 'mountain-king',
    title: 'In the Hall of the Mountain King',
    composer: 'Edvard Grieg',
    license: 'public-domain',
    src: `B3+B2 C#4 D4 E4 F#4+F#2 D4 F#4 F4+C#3 C#4 F4 E4+C3 C4 E4
          B3+B2 C#4 D4 E4 F#4+F#2 D4 F#4 B4 A4+F#2 F#4 D4 F#4 A4+D3
          B3+B2 C#4 D4 E4 F#4+F#2 D4 F#4 F4+C#3 C#4 F4 E4+C3 C4 E4
          B3+B2 C#4 D4 E4 F#4+F#2 D4 F#4 B4 A4+F#2 F#4 D4 F#4 B4+B2
          F#4+F#2 G#4 A#4 B4 C#5+C#3 A#4 C#5 D5+D3 A#4 D5 C#5+C#3 A#4 C#5
          F#4+F#2 G#4 A#4 B4 C#5+C#3 A#4 C#5 D5+D3 A#4 D5 C#5+C#3 C#5 F#5+F#3`,
  },
  {
    id: 'twinkle',
    title: 'Twinkle Twinkle Little Star',
    composer: 'Traditional (French folk)',
    license: 'public-domain',
    src: `C5+C4 C5 G5+E4 G5 A5+F4 A5 G5+E4 F5+D4 F5 E5+C4 E5 D5+G3 D5 C5+C4
          G5+E4 G5 F5+D4 F5 E5+C4 E5 D5+G3 G5+E4 G5 F5+D4 F5 E5+C4 E5 D5+G3
          C5+C4 C5 G5+E4 G5 A5+F4 A5 G5+E4 F5+D4 F5 E5+C4 E5 D5+G3 D5 C5+C4`,
  },
  {
    id: 'entertainer',
    title: 'The Entertainer',
    composer: 'Scott Joplin',
    license: 'public-domain',
    src: `D5 D#5 E5 C6+C4 E5 C6 E5 C6+E4 C6 D6 D#6 E6+G3 C6 D6 E6 B5+G3 D6 C6+C4
          D5 D#5 E5 C6+C4 E5 C6 E5 C6+E4 A5 G5 F#5 A5+D4 C6 E6 D6 C6 A5 D6+D4
          D5 D#5 E5 C6+C4 E5 C6 E5 C6+E4 C6 D6 D#6 E6+G3 C6 D6 E6 B5+G3 D6 C6+C4`,
  },
  {
    id: 'greensleeves',
    title: 'Greensleeves',
    composer: 'Traditional (English)',
    license: 'public-domain',
    src: `A4+A2 C5 D5+F3 E5 F5 E5 D5+G3 B4 G4 A4+A2 B4 C5 A4 A4+E3 G#4 A4 B4+E3 G#4 E4
          A4+A2 C5 D5+F3 E5 F5 E5 D5+G3 B4 G4 A4+A2 B4 C5+E3 B4 A4 G#4 F#4 G#4+E3 A4+A2 A4`,
  },
  {
    id: 'turkish-march',
    title: 'Rondo alla Turca',
    composer: 'Wolfgang Amadeus Mozart',
    license: 'public-domain',
    src: `B4 A4 G#4 A4 C5+A3 D5 C5 B4 C5 E5+A3 F5 E5 D#5 E5 B5 A5 G#5 A5 B5 A5 G#5 A5 C6+A3
          B4 A4 G#4 A4 C5+A3 D5 C5 B4 C5 E5+A3 F5 E5 D#5 E5 B5 A5 G#5 A5 B5 A5 G#5 A5 C6+A3`,
  },
  {
    id: 'jingle-bells',
    title: 'Jingle Bells',
    composer: 'James Lord Pierpont',
    license: 'public-domain',
    src: `E5+C4 E5 E5 E5+C4 E5 E5 E5+C4 G5 C5 D5 E5+C4 F5+F3 F5 F5 F5 F5+C4 E5 E5 E5 E5+D4 D5 D5 E5 D5+G3 G5
          E5+C4 E5 E5 E5+C4 E5 E5 E5+C4 G5 C5 D5 E5+C4 F5+F3 F5 F5 F5 F5+C4 E5 E5 E5 G5+G3 G5 F5 D5 C5+C4`,
  },
  {
    id: 'canon-in-d',
    title: 'Canon in D',
    composer: 'Johann Pachelbel',
    license: 'public-domain',
    src: `F#5+D3 E5+A2 D5+B2 C#5+F#2 B4+G2 A4+D2 B4+G2 C#5+A2
          D5+D3 C#5+A2 B4+B2 A4+F#2 G4+G2 F#4+D2 G4+G2 E4+A2
          F#5+D3 E5+A2 D5+B2 C#5+F#2 B4+G2 A4+D2 B4+G2 C#5+A2
          D5+D3 C#5+A2 B4+B2 A4+F#2 G4+G2 F#4+D2 G4+G2 E4+A2`,
  },
  {
    id: 'toccata',
    title: 'Toccata in D minor',
    composer: 'Johann Sebastian Bach',
    license: 'public-domain',
    src: `A5+D3 G5 A5 G5 F5 E5 D5 C#5 D5+D3
          A4+D3 G4 A4 E4 F4 C#4 D4+D2
          A3+D2 G3 A3 G3 F3 E3 D3 C#3 D3+D2`,
  },
  {
    id: 'brahms-lullaby',
    title: 'Lullaby (Wiegenlied)',
    composer: 'Johannes Brahms',
    license: 'public-domain',
    src: `E4 E4 G4+C3 E4 E4 G4+C3 E4 G4 C5+C3 B4 A4+F3 A4 G4+C3
          D4 E4 F4+G2 D4 D4 E4 F4+G2 D4 F4 B4+G2 A4 G4+G2 B4 C5+C3`,
  },
  {
    id: 'frere-jacques',
    title: 'Frère Jacques',
    composer: 'Traditional (French)',
    license: 'public-domain',
    src: `C5+C4 D5 E5 C5 C5+C4 D5 E5 C5 E5+C4 F5 G5 E5+C4 F5 G5
          G5+C4 A5 G5 F5 E5 C5 G5+C4 A5 G5 F5 E5 C5 C5+C4 G4 C5 C5+C4 G4 C5`,
  },
  {
    id: 'morning-mood',
    title: 'Morning Mood',
    composer: 'Edvard Grieg',
    license: 'public-domain',
    src: `G5+C4 E5 D5 C5 D5 E5 G5+C4 E5 D5 C5 D5+G3 E5 D5 E5 G5+C4 E5 G5 A5+F3 E5 A5 G5+C4 E5 D5 C5+C4`,
  },
  {
    id: 'saints',
    title: 'When the Saints Go Marching In',
    composer: 'Traditional (American)',
    license: 'public-domain',
    src: `C5+C4 E5 F5 G5+C4 C5 E5 F5 G5+C4 C5 E5 F5 G5+C4 E5 C5 E5 D5+G3
          E5 E5 D5 C5+C4 C5 E5 G5 G5 F5+F3 E5 F5 G5+C4 E5 C5 D5+G3 C5+C4`,
  },
  {
    id: 'amazing-grace',
    title: 'Amazing Grace',
    composer: 'Traditional (New Britain)',
    license: 'public-domain',
    src: `G3 C4+C3 E4 C4 E4+C3 D4 C4+F2 A3 G3+C3 G3 C4+C3 E4 C4 E4+C3 D4 G4+G2
          E4 G4+C3 E4 G4 E4+C3 C4 G3+C3 A3 C4+F2 A3 G3+C3 G3 C4+C3 E4 C4 E4+G2 D4 C4+C3`,
  },
];


export const MELODIES: Melody[] = defs.map(({ src, ...meta }) => ({ ...meta, steps: parseSteps(src) }));

export function getMelody(id: string): Melody {
  if (id.startsWith('generated')) return generatedMelody(Number(id.split('-')[1] ?? 1) || 1);
  const melody = MELODIES.find((m) => m.id === id);
  if (!melody) throw new Error(`Unknown melody: ${id}. Available: ${MELODIES.map((m) => m.id).join(', ')}`);
  return melody;
}
