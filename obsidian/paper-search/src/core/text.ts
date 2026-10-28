// The entries with an apostrophe ("aren't", "it's", ...) never match: tokenize splits on every character outside
// [a-z0-9], so "it's" becomes "it" and "s". They are kept as they are because removing them changes nothing, and
// splitting them into their parts would change ranking ("s", "t" and "ll" would become stopwords).
const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "aren't",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can't", "cannot", "could", "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't",
  "down", "during", "each", "few", "for", "from", "further", "had", "hadn't", "has", "hasn't", "have",
  "haven't", "having", "he", "he'd", "he'll", "he's", "her", "here", "here's", "hers", "herself",
  "him", "himself", "his", "how", "how's", "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into",
  "is", "isn't", "it", "it's", "its", "itself", "let's", "me", "more", "most", "mustn't", "my",
  "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other", "ought", "our",
  "ours", "ourselves", "out", "over", "own", "same", "shan't", "she", "she'd", "she'll", "she's",
  "should", "shouldn't", "so", "some", "such", "than", "that", "that's", "the", "their", "theirs",
  "them", "themselves", "then", "there", "there's", "these", "they", "they'd", "they'll", "they're",
  "they've", "this", "those", "through", "to", "too", "under", "until", "up", "very", "was", "wasn't",
  "we", "we'd", "we'll", "we're", "we've", "were", "weren't", "what", "what's", "when", "when's",
  "where", "where's", "which", "while", "who", "who's", "whom", "why", "why's", "with", "won't",
  "would", "wouldn't", "you", "you'd", "you'll", "you're", "you've", "your", "yours", "yourself",
  "yourselves"
]);

export interface TokenizeResult {
  tokens: string[];
  lastIncomplete: boolean;
}

export function tokenize(text: string): TokenizeResult {
  const rawParts = text.toLowerCase().split(/[^a-z0-9]+/);
  const tokens: string[] = [];
  for (const part of rawParts) {
    if (part.length > 0 && !STOPWORDS.has(part)) {
      tokens.push(part);
    }
  }
  // The last word typed may still be in progress. Trailing spaces and punctuation are ignored here, so a query
  // ranks the same with or without them; a trailing stopword ("cells in") means the token before it is finished.
  let lastRaw = "";
  for (let i = rawParts.length - 1; i >= 0 && !lastRaw; i--) lastRaw = rawParts[i];
  const lastIncomplete = tokens.length > 0 && tokens[tokens.length - 1] === lastRaw;
  return { tokens, lastIncomplete };
}

export function splitSentences(text: string): string[] {
  if (!text.trim()) return [];

  // Protect known abbreviations with placeholders
  let s = text
    .replace(/\bet al\./gi, "et al___DOT___")
    .replace(/\bFig\.\s*(\d+)/gi, "Fig___DOT___ $1")
    .replace(/\be\.g\./gi, "e___DOT___g___DOT___")
    .replace(/\bi\.e\./gi, "i___DOT___e___DOT___")
    .replace(/\bDr\./gi, "Dr___DOT___")
    .replace(/\bProf\./gi, "Prof___DOT___")
    .replace(/\bvs\./gi, "vs___DOT___")
    .replace(/(\d+)\.(\d+)/g, "$1___DOT___$2");

  // Split on sentence boundary [.!?] followed by whitespace or end of string
  const rawSentences = s.split(/(?<=[.!?])(?:\s+|$)/);
  const sentences: string[] = [];

  for (let sent of rawSentences) {
    sent = sent.replace(/___DOT___/g, ".").trim();
    if (sent.length > 0) {
      sentences.push(sent);
    }
  }
  return sentences;
}

export interface SnippetResult {
  text: string;
  sentence: string;
}

export function bestSnippet(text: string, queryTokens: string[], maxLen: number = 160): SnippetResult {
  const sentences = splitSentences(text);
  if (sentences.length === 0) {
    return { text: "", sentence: "" };
  }

  const queryTokenSet = new Set(queryTokens.map((t) => t.toLowerCase()));

  let bestSent = sentences[0];
  let maxOverlap = -1;

  for (const sent of sentences) {
    const { tokens } = tokenize(sent);
    let overlap = 0;
    for (const t of tokens) {
      if (queryTokenSet.has(t)) {
        overlap++;
      }
    }
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      bestSent = sent;
    }
  }

  if (bestSent.length <= maxLen) {
    return { text: bestSent, sentence: bestSent };
  }

  // Find position of first match
  const lowerSent = bestSent.toLowerCase();
  let firstMatchIdx = -1;
  for (const q of queryTokens) {
    const idx = lowerSent.indexOf(q.toLowerCase());
    if (idx !== -1 && (firstMatchIdx === -1 || idx < firstMatchIdx)) {
      firstMatchIdx = idx;
    }
  }

  if (firstMatchIdx === -1) {
    // No match found, take the beginning
    const trimmed = bestSent.slice(0, maxLen).trimEnd();
    return { text: `${trimmed}…`, sentence: bestSent };
  }

  // Center window around firstMatchIdx
  const half = Math.floor(maxLen / 2);
  let start = Math.max(0, firstMatchIdx - half);
  let end = start + maxLen;
  if (end > bestSent.length) {
    end = bestSent.length;
    start = Math.max(0, end - maxLen);
  }

  // Adjust start and end to avoid cutting words in half
  if (start > 0) {
    const nextSpace = bestSent.indexOf(" ", start);
    if (nextSpace !== -1 && nextSpace < firstMatchIdx) {
      start = nextSpace + 1;
    }
  }
  if (end < bestSent.length) {
    const prevSpace = bestSent.lastIndexOf(" ", end);
    if (prevSpace !== -1 && prevSpace > start) {
      end = prevSpace;
    }
  }

  let snippet = bestSent.slice(start, end).trim();
  if (start > 0) {
    snippet = `…${snippet}`;
  }
  if (end < bestSent.length) {
    snippet = `${snippet}…`;
  }

  return { text: snippet, sentence: bestSent };
}
