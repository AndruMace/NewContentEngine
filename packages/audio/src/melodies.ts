import { generatedMelody, parseMelody, type Melody } from '@sim/engine';

/**
 * Melody library. Every entry is our own transcription of a public-domain composition
 * (composer died 70+ years ago, published before 1929), so both the work and the
 * transcription are free of copyright. Do not add transcriptions copied from MIDI sites.
 *
 * Timing (see parseMelody): "*n" is a step's length in units of `unit` quarter notes, each line
 * is a phrase, and `bpm` is in quarter notes. Untimed templates only read the pitches.
 */

const defs: (Omit<Melody, 'steps' | 'beats' | 'phrases'> & { src: string })[] = [
  {
    id: 'ode-to-joy',
    title: 'Ode to Joy',
    composer: 'Ludwig van Beethoven',
    license: 'public-domain',
    bpm: 116,
    src: `E5+C4 E5 F5 G5 G5+B3 F5 E5 D5 C5+A3 C5 D5 E5 E5+G3*1.5 D5*0.5 D5*2
          E5+C4 E5 F5 G5 G5+B3 F5 E5 D5 C5+A3 C5 D5 E5 D5+G3*1.5 C5*0.5 C5*2
          D5+G3 D5 E5 C5 D5 E5*0.5 F5*0.5 E5 C5 D5 E5*0.5 F5*0.5 E5 D5 C5 D5 G4*2
          E5+C4 E5 F5 G5 G5+B3 F5 E5 D5 C5+A3 C5 D5 E5 D5+G3*1.5 C5*0.5 C5*2`,
  },
  {
    id: 'fur-elise',
    title: 'Für Elise',
    composer: 'Ludwig van Beethoven',
    license: 'public-domain',
    bpm: 66,
    unit: 0.25,
    src: `E5 D#5 E5 D#5 E5 B4 D5 C5 A4+A2*3 C4 E4 A4 B4+E2*3 E4 G#4 B4 C5+A2*3 E4 E5 D#5 E5 D#5 E5 B4 D5 C5 A4+A2*3 C4 E4 A4 B4+E2*3 E4 C5 B4 A4+A2*4
          E5 D#5 E5 D#5 E5 B4 D5 C5 A4+A2*3 C4 E4 A4 B4+E2*3 E4 G#4 B4 C5+A2*3 E4 E5 D#5 E5 D#5 E5 B4 D5 C5 A4+A2*3 C4 E4 A4 B4+E2*3 E4 C5 B4 A4+A2*3
          B4 C5 D5 E5+C3*3 G4 F5 E5 D5+G2*3 F4 E5 D5 C5+A2*3 E4 D5 C5 B4+E2*4`,
  },
  {
    id: 'mountain-king',
    title: 'In the Hall of the Mountain King',
    composer: 'Edvard Grieg',
    license: 'public-domain',
    bpm: 112,
    unit: 0.5,
    src: `B3+B2 C#4 D4 E4 F#4+F#2 D4 F#4*2 F4+C#3 C#4 F4*2 E4+C3 C4 E4*2
          B3+B2 C#4 D4 E4 F#4+F#2 D4 F#4 B4 A4+F#2 F#4 D4 F#4 A4+D3*4
          B3+B2 C#4 D4 E4 F#4+F#2 D4 F#4*2 F4+C#3 C#4 F4*2 E4+C3 C4 E4*2
          B3+B2 C#4 D4 E4 F#4+F#2 D4 F#4 B4 A4+F#2 F#4 D4 F#4 B4+B2*4
          F#4+F#2 G#4 A#4 B4 C#5+C#3 A#4 C#5*2 D5+D3 A#4 D5*2 C#5+C#3 A#4 C#5*2
          F#4+F#2 G#4 A#4 B4 C#5+C#3 A#4 C#5*2 D5+D3 A#4 D5*2 C#5+C#3*2 C#5*2 F#5+F#3*4`,
  },
  {
    id: 'twinkle',
    title: 'Twinkle Twinkle Little Star',
    composer: 'Traditional (French folk)',
    license: 'public-domain',
    bpm: 104,
    src: `C5+C4 C5 G5+E4 G5 A5+F4 A5 G5+E4*2 F5+D4 F5 E5+C4 E5 D5+G3 D5 C5+C4*2
          G5+E4 G5 F5+D4 F5 E5+C4 E5 D5+G3*2 G5+E4 G5 F5+D4 F5 E5+C4 E5 D5+G3*2
          C5+C4 C5 G5+E4 G5 A5+F4 A5 G5+E4*2 F5+D4 F5 E5+C4 E5 D5+G3 D5 C5+C4*2`,
  },
  {
    id: 'entertainer',
    title: 'The Entertainer',
    composer: 'Scott Joplin',
    license: 'public-domain',
    bpm: 76,
    unit: 0.25,
    src: `D5 D#5 E5 C6+C4*2 E5 C6*2 E5 C6+E4*6 C6 D6 D#6 E6+G3 C6 D6 E6*2 B5+G3 D6*2 C6+C4*6
          D5 D#5 E5 C6+C4*2 E5 C6*2 E5 C6+E4*7 A5 G5 F#5 A5+D4 C6 E6*2 D6 C6 A5 D6+D4*6
          D5 D#5 E5 C6+C4*2 E5 C6*2 E5 C6+E4*6 C6 D6 D#6 E6+G3 C6 D6 E6*2 B5+G3 D6*2 C6+C4*6`,
  },
  {
    id: 'greensleeves',
    title: 'Greensleeves',
    composer: 'Traditional (English)',
    license: 'public-domain',
    bpm: 75,
    unit: 0.25,
    src: `A4+A2*2 C5*4 D5+F3*2 E5*3 F5 E5*2 D5+G3*4 B4*2 G4*3 A4+A2 B4*2 C5*4 A4*2 A4+E3*3 G#4 A4*2 B4+E3*4 G#4*2 E4*4
          A4+A2*2 C5*4 D5+F3*2 E5*3 F5 E5*2 D5+G3*4 B4*2 G4*3 A4+A2 B4*2 C5+E3*3 B4 A4*2 G#4*3 F#4 G#4+E3*2 A4+A2*6 A4*4`,
  },
  {
    id: 'turkish-march',
    title: 'Rondo alla Turca',
    composer: 'Wolfgang Amadeus Mozart',
    license: 'public-domain',
    bpm: 112,
    unit: 0.25,
    src: `B4 A4 G#4 A4 C5+A3*4 D5 C5 B4 C5 E5+A3*4 F5 E5 D#5 E5 B5 A5 G#5 A5 B5 A5 G#5 A5 C6+A3*4
          B4 A4 G#4 A4 C5+A3*4 D5 C5 B4 C5 E5+A3*4 F5 E5 D#5 E5 B5 A5 G#5 A5 B5 A5 G#5 A5 C6+A3*4`,
  },
  {
    id: 'jingle-bells',
    title: 'Jingle Bells',
    composer: 'James Lord Pierpont',
    license: 'public-domain',
    bpm: 132,
    src: `E5+C4 E5 E5*2 E5+C4 E5 E5*2 E5+C4 G5 C5*1.5 D5*0.5 E5+C4*4 F5+F3 F5 F5*1.5 F5*0.5 F5+C4 E5 E5 E5 E5+D4 D5 D5 E5 D5+G3*2 G5*2
          E5+C4 E5 E5*2 E5+C4 E5 E5*2 E5+C4 G5 C5*1.5 D5*0.5 E5+C4*4 F5+F3 F5 F5*1.5 F5*0.5 F5+C4 E5 E5 E5 G5+G3 G5 F5 D5 C5+C4*4`,
  },
  {
    id: 'canon-in-d',
    title: 'Canon in D',
    composer: 'Johann Pachelbel',
    license: 'public-domain',
    bpm: 120,
    unit: 2,
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
    bpm: 60,
    unit: 0.125,
    src: `A5+D3 G5 A5*14 G5*2 F5*2 E5*2 D5*2 C#5*8 D5+D3*16
          A4+D3 G4 A4*14 E4*4 F4*4 C#4*8 D4+D2*16
          A3+D2 G3 A3*14 G3*2 F3*2 E3*2 D3*2 C#3*8 D3+D2*16`,
  },
  {
    id: 'brahms-lullaby',
    title: 'Lullaby (Wiegenlied)',
    composer: 'Johannes Brahms',
    license: 'public-domain',
    bpm: 72,
    unit: 0.5,
    src: `E4 E4 G4+C3*3 E4 E4*2 G4+C3*4 E4 G4 C5+C3*2 B4*3 A4+F3 A4*2 G4+C3*2
          D4 E4 F4+G2*2 D4*2 D4 E4 F4+G2*4 D4 F4 B4+G2 A4 G4+G2*2 B4*2 C5+C3*4`,
  },
  {
    id: 'frere-jacques',
    title: 'Frère Jacques',
    composer: 'Traditional (French)',
    license: 'public-domain',
    bpm: 104,
    unit: 0.5,
    src: `C5+C4*2 D5*2 E5*2 C5*2 C5+C4*2 D5*2 E5*2 C5*2 E5+C4*2 F5*2 G5*4 E5+C4*2 F5*2 G5*4
          G5+C4 A5 G5 F5 E5*2 C5*2 G5+C4 A5 G5 F5 E5*2 C5*2 C5+C4*2 G4*2 C5*4 C5+C4*2 G4*2 C5*4`,
  },
  {
    id: 'morning-mood',
    title: 'Morning Mood',
    composer: 'Edvard Grieg',
    license: 'public-domain',
    bpm: 84,
    unit: 0.25,
    src: `G5+C4*2 E5*2 D5*2 C5*2 D5*2 E5*2 G5+C4*2 E5*2 D5*2 C5*2 D5+G3 E5 D5 E5
          G5+C4*2 E5*2 G5*2 A5+F3*2 E5*2 A5*2 G5+C4*2 E5*2 D5*2 C5+C4*6`,
  },
  {
    id: 'saints',
    title: 'When the Saints Go Marching In',
    composer: 'Traditional (American)',
    license: 'public-domain',
    bpm: 144,
    src: `C5+C4 E5 F5 G5+C4*5 C5 E5 F5 G5+C4*5 C5 E5 F5 G5+C4*2 E5*2 C5*2 E5*2 D5+G3*5
          E5 E5 D5 C5+C4*3 C5 E5*2 G5 G5 F5+F3*2 E5 F5 G5+C4*2 E5*2 C5*2 D5+G3*2 C5+C4*5`,
  },
  {
    id: 'amazing-grace',
    title: 'Amazing Grace',
    composer: 'Traditional (New Britain)',
    license: 'public-domain',
    bpm: 84,
    unit: 0.5,
    src: `G3*2 C4+C3*4 E4 C4 E4+C3*4 D4*2 C4+F2*4 A3*2 G3+C3*4 G3*2 C4+C3*4 E4 C4 E4+C3*4 D4*2 G4+G2*4
          E4*2 G4+C3*4 E4 G4 E4+C3*4 C4*2 G3+C3*4 A3*2 C4+F2*4 A3*2 G3+C3*4 G3*2 C4+C3*4 E4 C4 E4+G2*4 D4*2 C4+C3*4`,
  },
  {
    id: 'deck-the-halls',
    title: 'Deck the Halls',
    composer: 'Traditional (Welsh)',
    license: 'public-domain',
    bpm: 126,
    src: `G5+C4*1.5 F5*0.5 E5 D5 C5+C4 D5 E5 C5 D5+G3*0.5 E5*0.5 F5*0.5 D5*0.5 E5+C4*1.5 D5*0.5 C5 B4+G3 C5+C4*2
          G5+C4*1.5 F5*0.5 E5 D5 C5+C4 D5 E5 C5 D5+G3*0.5 E5*0.5 F5*0.5 D5*0.5 E5+C4*1.5 D5*0.5 C5 B4+G3 C5+C4*2
          D5+G3*1.5 E5*0.5 F5 D5 E5+C4*1.5 F5*0.5 G5 D5 E5+C4*0.5 F#5*0.5 G5 A5*0.5 B5*0.5 C6 B5+D4 A5 G5+G3*2
          G5+C4*1.5 F5*0.5 E5 D5 C5+C4 D5 E5 C5 A5+F3*0.5 A5*0.5 A5*0.5 A5*0.5 G5+C4*1.5 F5*0.5 E5+G3 D5 C5+C4*2`,
  },
  {
    id: 'we-wish-you',
    title: 'We Wish You a Merry Christmas',
    composer: 'Traditional (English)',
    license: 'public-domain',
    bpm: 168,
    src: `G4 C5+C3 C5*0.5 D5*0.5 C5*0.5 B4*0.5 A4+F3 A4 A4 D5+D3 D5*0.5 E5*0.5 D5*0.5 C5*0.5 B4+G3 G4 G4 E5+E3 E5*0.5 F5*0.5 E5*0.5 D5*0.5 C5+F3 A4 G4*0.5 G4*0.5 A4+G3 D5 B4 C5+C3*3
          G4 C5+C3 C5 C5 B4+G3*2 B4 C5+C3 B4 A4 G4+G3*2 D5 E5+C3 D5 C5 G5+E3 G4 G4*0.5 G4*0.5 A4+G3 D5 B4 C5+C3*3`,
  },
  {
    id: 'joy-to-the-world',
    title: 'Joy to the World',
    composer: 'Lowell Mason, after Handel',
    license: 'public-domain',
    bpm: 84,
    unit: 0.5,
    src: `C6+C4*2 B5*1.5 A5*0.5 G5+E4*3 F5 E5+C4*2 D5+G3*2 C5+C4*3
          G5 A5+F3*3 A5 B5+G3*3 B5 C6+C4*3
          C6 C6+C4 B5 A5 G5 G5+C4*1.5 F5*0.5 E5 C6 C6+F3 B5 A5 G5 G5+C4*1.5 F5*0.5 E5 E5
          E5+C4 E5 E5 E5*0.5 F5*0.5 G5*3 F5*0.5 E5*0.5 D5+G3 D5 D5 D5*0.5 E5*0.5 F5*3 E5*0.5 D5*0.5 C5+C4 C6*2 A5+F3 G5*1.5 F5*0.5 E5+C4 F5 E5+G3*2 D5*2 C5+C4*4`,
  },
  {
    id: 'silent-night',
    title: 'Silent Night',
    composer: 'Franz Xaver Gruber',
    license: 'public-domain',
    bpm: 72,
    unit: 0.5,
    src: `G4+C3*1.5 A4*0.5 G4 E4*3 G4+C3*1.5 A4*0.5 G4 E4*3
          D5+G2*2 D5 B4*3 C5+C3*2 C5 G4*3
          A4+F2*2 A4 C5*1.5 B4*0.5 A4 G4+C3*1.5 A4*0.5 G4 E4*3
          A4+F2*2 A4 C5*1.5 B4*0.5 A4 G4+C3*1.5 A4*0.5 G4 E4*3
          D5+G2*2 D5 F5*1.5 D5*0.5 B4 C5+C3*3 E5*3
          C5+C3 G4 E4 G4+G2*1.5 F4*0.5 D4 C4+C3*6`,
  },
  {
    id: 'mary-lamb',
    title: 'Mary Had a Little Lamb',
    composer: 'Traditional (American)',
    license: 'public-domain',
    bpm: 116,
    src: `E5+C4 D5 C5 D5 E5+C4 E5 E5*2 D5+G3 D5 D5*2 E5+C4 G5 G5*2
          E5+C4 D5 C5 D5 E5+C4 E5 E5 E5 D5+G3 D5 E5 D5 C5+C4*4`,
  },
  {
    id: 'london-bridge',
    title: 'London Bridge Is Falling Down',
    composer: 'Traditional (English)',
    license: 'public-domain',
    bpm: 112,
    src: `G4+C3*1.5 A4*0.5 G4 F4 E4+C3 F4 G4*2 D4+G2 E4 F4*2 E4+C3 F4 G4*2
          G4+C3*1.5 A4*0.5 G4 F4 E4+C3 F4 G4*2 D4+G2*2 G4*2 E4+C3 C4*3`,
  },
  {
    id: 'row-your-boat',
    title: 'Row, Row, Row Your Boat',
    composer: 'Traditional (American)',
    license: 'public-domain',
    bpm: 100,
    unit: 0.5,
    src: `C5+C4*3 C5*3 C5*2 D5 E5+C4*3 E5*2 D5 E5*2 F5 G5+C4*6
          C6+C4 C6 C6 G5 G5 G5 E5+C4 E5 E5 C5 C5 C5 G5+G3*2 F5 E5*2 D5 C5+C4*6`,
  },
  {
    id: 'old-macdonald',
    title: 'Old MacDonald Had a Farm',
    composer: 'Traditional',
    license: 'public-domain',
    bpm: 132,
    src: `C5+C3 C5 C5 G4 A4+F3 A4 G4+C3*2 E5+C3 E5 D5+G2 D5 C5+C3*3
          G4 C5+C3 C5 C5 G4 A4+F3 A4 G4+C3*2 E5+C3 E5 D5+G2 D5 C5+C3*4`,
  },
  {
    id: 'oh-susanna',
    title: 'Oh! Susanna',
    composer: 'Stephen Foster',
    license: 'public-domain',
    bpm: 132,
    src: `C5*0.5 D5*0.5 E5+C4 G5 G5*1.5 A5*0.5 G5+C4 E5 C5*1.5 D5*0.5 E5+C4 E5 D5 C5 D5+G3*3
          C5*0.5 D5*0.5 E5+C4 G5 G5*1.5 A5*0.5 G5+C4 E5 C5*1.5 D5*0.5 E5+G3 E5 D5 D5 C5+C4*4`,
  },
  {
    id: 'camptown-races',
    title: 'Camptown Races',
    composer: 'Stephen Foster',
    license: 'public-domain',
    bpm: 120,
    unit: 0.5,
    src: `G5+C4 G5 E5 G5 A5+F3 G5 E5*2 E5+G3 D5*3 E5+G3 D5*3
          G5+C4 G5 E5 G5 A5+F3 G5 E5*2 D5+G3*2 D5 E5 D5*2 C5+C4*2`,
  },
  {
    id: 'yankee-doodle',
    title: 'Yankee Doodle',
    composer: 'Traditional (American)',
    license: 'public-domain',
    bpm: 116,
    unit: 0.5,
    src: `C5+C4 C5 D5 E5 C5+C4 E5 D5+G3 G4 C5+C4 C5 D5 E5 C5+C4*2 B4+G3*2
          C5+C4 C5 D5 E5 F5+F3 E5 D5 C5 B4+G3 G4 A4 B4 C5+C4*2 C5*2
          A4+F3 B4 A4 G4 A4+F3 B4 C5*2 G4+C3 A4 G4 F4 E4+C3*2 G4*2
          A4+F3 B4 A4 G4 A4+F3 B4 C5 A4 G4+G3 C5 B4 D5 C5+C4*2 C5*2`,
  },
  {
    id: 'auld-lang-syne',
    title: 'Auld Lang Syne',
    composer: 'Traditional (Scottish)',
    license: 'public-domain',
    bpm: 76,
    src: `C4 F4+F3*1.5 E4*0.5 F4 A4 G4+C3*1.5 F4*0.5 G4 A4 F4+F3*1.5 F4*0.5 A4 C5 D5+Bb2*3
          D5 C5+F3*1.5 A4*0.5 A4 F4 G4+C3*1.5 F4*0.5 G4 A4 F4+Bb2*1.5 D4*0.5 D4 C4+C3 F4+F3*3`,
  },
  {
    id: 'can-can',
    title: 'Can-Can',
    composer: 'Jacques Offenbach',
    license: 'public-domain',
    bpm: 144,
    unit: 0.5,
    src: `C5+C4*4 D5 F5 E5 D5 G5+G3*2 G5*2 G5 A5 E5 F5 D5+G3*2 D5*2 D5 F5 E5 D5 C5+C4 C6 B5 A5 G5+G3 F5 E5 D5
          C5+C4*4 D5 F5 E5 D5 G5+G3*2 G5*2 G5 A5 E5 F5 D5+G3*2 D5*2 D5 F5 E5 D5 C5+C4 G5 E5 D5 C5+C4*4`,
  },
  {
    id: 'new-world-largo',
    title: 'New World Symphony (Largo)',
    composer: 'Antonín Dvořák',
    license: 'public-domain',
    bpm: 60,
    src: `E5+C4*1.5 G5*0.5 G5*2 E5+A3*1.5 D5*0.5 C5*2 D5+F3 E5 G5 E5 D5+G3*4
          E5+C4*1.5 G5*0.5 G5*2 E5+A3*1.5 D5*0.5 C5*2 D5+G3 E5 D5*2 C5+C4*4`,
  },
  {
    id: 'blue-danube',
    title: 'The Blue Danube',
    composer: 'Johann Strauss II',
    license: 'public-domain',
    bpm: 192,
    src: `C4+C3 C4 E4 G4*5 G5 G5*2 E5 E5*3
          C4+C3 C4 E4 G4*5 G5 G5*2 F5 F5*3
          B3+G2 B3 D4 A4*5 A5 A5*2 F5 F5*3
          B3+G2 B3 D4 A4*5 A5 A5*2 E5 E5*3
          C4+C3 C4 E4 G4 C5*4 C6 C6*2 G5 G5*3
          C4+C3 C4 E4 G4 C5*4 C6 C6*2 A5 A5*3
          D4+G2 D4 F4 A4*4 F#4 G4 E5*4 C5 E4 E4*3 D4 A4*3 G4 C4+C3*3`,
  },
  {
    id: 'swan-lake',
    title: 'Swan Lake',
    composer: 'Pyotr Ilyich Tchaikovsky',
    license: 'public-domain',
    bpm: 72,
    src: `F#4+B2*3 B4*0.5 C#5*0.5 D5*0.5 E5*0.5 F#5+B2*1.5 D5*0.5 F#5*1.5 D5*0.5 F#5+G2*1.5 B4*0.5 D5*0.5 B4*0.5 G4*0.5 D5*0.5 B4+B2*4
          F#4+B2*3 B4*0.5 C#5*0.5 D5*0.5 E5*0.5 F#5+B2*1.5 D5*0.5 F#5*1.5 D5*0.5 F#5+G2*1.5 B4*0.5 D5*0.5 B4*0.5 G4*0.5 D5*0.5 B4+B2*4`,
  },
  {
    id: 'minuet-in-g',
    title: 'Minuet in G',
    composer: 'Christian Petzold (attr. J. S. Bach)',
    license: 'public-domain',
    bpm: 120,
    src: `D5+G3 G4*0.5 A4*0.5 B4*0.5 C5*0.5 D5+B3 G4 G4 E5+C4 C5*0.5 D5*0.5 E5*0.5 F#5*0.5 G5+B3 G4 G4 C5+A3 D5*0.5 C5*0.5 B4*0.5 A4*0.5 B4+G3 C5*0.5 B4*0.5 A4*0.5 G4*0.5 F#4+D3 G4*0.5 A4*0.5 B4*0.5 G4*0.5 A4+D3*3
          D5+G3 G4*0.5 A4*0.5 B4*0.5 C5*0.5 D5+B3 G4 G4 E5+C4 C5*0.5 D5*0.5 E5*0.5 F#5*0.5 G5+B3 G4 G4 C5+A3 D5*0.5 C5*0.5 B4*0.5 A4*0.5 B4+G3 C5*0.5 B4*0.5 A4*0.5 G4*0.5 A4+D3 B4*0.5 A4*0.5 G4*0.5 F#4*0.5 G4+G3*3`,
  },
];

export const MELODIES: Melody[] = defs.map(({ src, ...meta }) => ({ ...meta, ...parseMelody(src) }));

export function getMelody(id: string): Melody {
  if (id.startsWith('generated')) return generatedMelody(Number(id.split('-')[1] ?? 1) || 1);
  const melody = MELODIES.find((m) => m.id === id);
  if (!melody) throw new Error(`Unknown melody: ${id}. Available: ${MELODIES.map((m) => m.id).join(', ')}`);
  return melody;
}
