export const exampleTopics = [{ id: 11, title: 'Entrada' }, { id: 22, title: 'Letter K' }, { id: 33, title: 'Letter S' }];
export const examplePosts = [10, 2, 3].map((episode, index) => ({
  id: index + 41, kind: 'document', filename: '[Demo]Kestrel_Circuit-S04E' + String(episode).padStart(2, '0') + '.mkv',
})).concat([{ id: 44, kind: 'document', filename: '[Demo]Saffron_Signals-S01E01.mkv' }]);

const candidates = {
  'kestrel circuit': [
    { id: 1, titles: ['Kestrel Circuit — Temporada 4', 'Kestrel Circuit'], year: 2025, format: 'TV',
      episodes: 12, studios: ['Estúdio Horizonte'], genres: ['Aventura', 'Ficção científica'] },
    { id: 2, titles: ['Kestrel Circuit — Especial'], year: 2024, format: 'SPECIAL',
      episodes: 1, studios: ['Estúdio Horizonte'], genres: ['Aventura'] },
  ],
  'saffron signals': [
    { id: 3, titles: ['Saffron Signals'], year: 2023, format: 'TV',
      episodes: 12, studios: ['Estúdio Estação'], genres: ['Mistério'] },
  ],
};

export function exampleCandidates(title) {
  return candidates[title.toLowerCase()] ?? [];
}
