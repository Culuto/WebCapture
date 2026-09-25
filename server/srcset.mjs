export function parseSrcset(input) {
  const source = String(input || '');
  const candidates = [];
  const whitespace = /[\t\n\f\r ]/;
  let position = 0;
  while (position < source.length) {
    while (position < source.length && (whitespace.test(source[position]) || source[position] === ',')) position += 1;
    const start = position;
    while (position < source.length && !whitespace.test(source[position])) position += 1;
    let url = source.slice(start, position);
    if (!url) break;
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
      if (url) candidates.push({ url, descriptor: '' });
      continue;
    }
    const descriptorsStart = position;
    let parentheses = 0;
    while (position < source.length) {
      const character = source[position];
      if (character === '(') parentheses += 1;
      if (character === ')') parentheses = Math.max(0, parentheses - 1);
      if (character === ',' && !parentheses) break;
      position += 1;
    }
    candidates.push({ url, descriptor: source.slice(descriptorsStart, position).trim() });
    if (source[position] === ',') position += 1;
  }
  return candidates;
}

export function mapSrcset(input, mapUrl) {
  return parseSrcset(input).map(({ url, descriptor }) => `${mapUrl(url)}${descriptor ? ` ${descriptor}` : ''}`).join(', ');
}
