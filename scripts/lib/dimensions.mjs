// Parses GALC's free-text `dimensions` field into numeric inches.
//
// Every observed value in the collection is "<number> x <number>" followed by
// some inch mark -- but the field uses at least five different characters for
// that mark (a straight quote, two apostrophes, a curly quote, a mojibake byte,
// or nothing at all), so we ignore the suffix entirely and read the two numbers.
//
// The number ORDER is not trustworthy. Measured against the collection's own
// thumbnails, the string is height-first only about half the time. The two
// magnitudes are reliable (they match the image's aspect ratio to ~1.6% median
// error), so we take the pair from the text and let the image decide which one
// is the height.

/** Every character the collection uses as an inch mark, including mojibake. */
const INCH_MARKS = /["'‘’“”′″]+/g;
const PAIR = /(\d+(?:\.\d+)?)\s*[x×X]\s*(\d+(?:\.\d+)?)/;

/** Ratio tolerance within which we call the text/image agreement "high". */
const RATIO_TOLERANCE = 0.08;
/** Below this aspect difference an item is treated as square (orientation moot). */
const SQUARE_TOLERANCE = 0.03;

/**
 * Pull the two numbers out of a raw dimensions string.
 * @param {string|null|undefined} raw
 * @returns {{first: number, second: number} | null}
 */
export function parseDimensionPair(raw) {
  if (typeof raw !== 'string') return null;
  // Strip inch marks first: some values put one between the number and the "x"
  // (`16.5" x 23 "`), which would otherwise break a single combined pattern.
  const match = raw.replace(INCH_MARKS, ' ').match(PAIR);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (!isFinite(first) || !isFinite(second) || first <= 0 || second <= 0) return null;
  return { first, second };
}

/**
 * Resolve a raw dimensions string into width/height inches, using the item's
 * image proportions to settle which number is which.
 *
 * @param {string|null|undefined} raw
 * @param {{width: number, height: number} | null | undefined} imageSize
 * @returns {{
 *   width_in: number|null, height_in: number|null,
 *   orientation: 'portrait'|'landscape'|'square'|null,
 *   confidence: 'high'|'medium'|'low'|'none',
 *   raw: string|null
 * }}
 */
export function resolveDimensions(raw, imageSize) {
  const rawText = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  const pair = parseDimensionPair(raw);
  if (!pair) {
    return { width_in: null, height_in: null, orientation: null, confidence: 'none', raw: rawText };
  }

  const short = Math.min(pair.first, pair.second);
  const long = Math.max(pair.first, pair.second);
  const textRatio = short / long;
  const nearlySquare = 1 - textRatio < SQUARE_TOLERANCE;

  const usable = imageSize && imageSize.width > 0 && imageSize.height > 0;
  if (!usable) {
    // No image to arbitrate: fall back to the art-world default of height first.
    return {
      width_in: round2(pair.second),
      height_in: round2(pair.first),
      orientation: orientationOf(pair.second, pair.first),
      confidence: 'low',
      raw: rawText
    };
  }

  const imagePortrait = imageSize.height > imageSize.width;
  const imageRatio =
    Math.min(imageSize.width, imageSize.height) / Math.max(imageSize.width, imageSize.height);
  const agrees = Math.abs(textRatio - imageRatio) / imageRatio < RATIO_TOLERANCE;

  const width = imagePortrait ? short : long;
  const height = imagePortrait ? long : short;

  return {
    width_in: round2(width),
    height_in: round2(height),
    orientation: nearlySquare ? 'square' : orientationOf(width, height),
    // `medium` means we trusted the image for orientation but the numbers
    // describe proportions the image does not share -- often a sheet-vs-image
    // measurement, so treat the values as approximate.
    confidence: agrees ? 'high' : 'medium',
    raw: rawText
  };
}

function orientationOf(width, height) {
  if (Math.abs(width - height) / Math.max(width, height) < SQUARE_TOLERANCE) return 'square';
  return height > width ? 'portrait' : 'landscape';
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
