export const VISUAL_CELL = 32;
const SAMPLE = 4;
const MAX_HEIGHT = 16000;

export function diffGrid(a, b, width, height, { cell = VISUAL_CELL, sample = SAMPLE, threshold = 0.08 } = {}) {
  const gridCols = Math.max(1, Math.ceil(width / sample));
  const gridRows = Math.max(1, Math.ceil(height / sample));
  const sums = new Float64Array(gridCols * gridRows);
  const counts = new Uint32Array(gridCols * gridRows);
  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(gridRows - 1, Math.floor(y / sample));
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(gridCols - 1, Math.floor(x / sample));
      const offset = (y * width + x) * 4;
      const difference = (Math.abs(a[offset] - b[offset]) + Math.abs(a[offset + 1] - b[offset + 1]) + Math.abs(a[offset + 2] - b[offset + 2])) / 765;
      sums[gy * gridCols + gx] += difference;
      counts[gy * gridCols + gx] += 1;
    }
  }
  const changed = [];
  for (let index = 0; index < sums.length; index += 1) {
    if (counts[index] && sums[index] / counts[index] > threshold) changed.push([index % gridCols, Math.floor(index / gridCols)]);
  }
  return { cols: gridCols, rows: gridRows, cellSize: cell, changed, similarity: Math.round((1 - changed.length / sums.length) * 1000) / 1000 };
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    image.src = source;
  });
}

function pixels(image, width, height, scaledWidth, scaledHeight) {
  const canvas = document.createElement('canvas');
  canvas.width = scaledWidth;
  canvas.height = scaledHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, scaledWidth, scaledHeight);
  context.drawImage(image, 0, 0, width, height, 0, 0, scaledWidth, scaledHeight);
  return context.getImageData(0, 0, scaledWidth, scaledHeight).data;
}

export function compareImages(saved, replay, { cell = VISUAL_CELL, threshold = 0.08 } = {}) {
  const width = Math.min(saved.naturalWidth, replay.naturalWidth);
  const height = Math.min(saved.naturalHeight, replay.naturalHeight, MAX_HEIGHT);
  if (!width || !height) throw new Error('比べる画像が空です。');
  const scale = SAMPLE / cell;
  const scaledWidth = Math.max(1, Math.ceil(width * scale));
  const scaledHeight = Math.max(1, Math.ceil(height * scale));
  const grid = diffGrid(pixels(saved, width, height, scaledWidth, scaledHeight), pixels(replay, width, height, scaledWidth, scaledHeight), scaledWidth, scaledHeight, { cell, sample: SAMPLE, threshold });
  return {
    ...grid, width, height,
    savedSize: [saved.naturalWidth, saved.naturalHeight], replaySize: [replay.naturalWidth, replay.naturalHeight],
    heightDifference: replay.naturalHeight - saved.naturalHeight
  };
}

export async function compareImageUrls(savedUrl, replayUrl, options = {}) {
  const [saved, replay] = await Promise.all([loadImage(savedUrl), loadImage(replayUrl)]);
  return compareImages(saved, replay, options);
}

export function drawDiffOverlay(canvas, image, result, { maxWidth = 900 } = {}) {
  const scale = Math.min(1, maxWidth / image.naturalWidth);
  const drawnHeight = Math.min(image.naturalHeight, result.height);
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(drawnHeight * scale);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, image.naturalWidth, drawnHeight, 0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(220, 38, 38, 0.28)';
  context.strokeStyle = 'rgba(220, 38, 38, 0.9)';
  context.lineWidth = 1;
  const size = result.cellSize * scale;
  for (const [x, y] of result.changed || []) {
    context.fillRect(x * size, y * size, size, size);
    context.strokeRect(x * size + 0.5, y * size + 0.5, size - 1, size - 1);
  }
}
