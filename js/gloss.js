/* ============================================================
   SgSL Hub — SgSL Gloss Parser
   ============================================================
   Rule-based English → SgSL gloss converter.

   SgSL grammar rules applied:
   1. Topic-comment structure (object before verb)
   2. Time markers come first
   3. Questions marked by NMM (eyebrow raise), not word order
   4. Negation uses head shake
   5. Pronouns simplified (I, YOU, HE/SHE → point signs)
   6. Articles/prepositions dropped (a, the, to, at, in, on)
   7. Copula dropped (is, am, are, was, were)

   Output: Array of { sign: string, nmm: string|null }
   where nmm can be: 'question', 'negation', 'topic', null
   ============================================================ */

// Words to drop (articles, prepositions, copula, auxiliaries)
const DROP_WORDS = new Set([
  'a', 'an', 'the',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did',
  'to', 'at', 'in', 'on', 'of', 'for', 'with', 'by',
  'it', 'its',
  'has', 'have', 'had',
  'will', 'would', 'shall', 'should', 'could', 'can', 'may', 'might',
  'just', 'very', 'really', 'quite',
]);

// Time markers — these get moved to the front
const TIME_WORDS = new Set([
  'yesterday', 'today', 'tomorrow', 'now', 'later', 'before',
  'after', 'morning', 'afternoon', 'evening', 'night',
  'always', 'sometimes', 'never', 'often', 'recently',
  'last', 'next', 'ago',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]);

// Question words
const QUESTION_WORDS = new Set([
  'what', 'where', 'when', 'who', 'whom', 'why', 'how',
  'which', 'whose',
]);

// Negation words
const NEGATION_WORDS = new Set([
  'not', "n't", 'no', 'never', 'nothing', 'nobody', 'none',
  "don't", "doesn't", "didn't", "won't", "wouldn't", "can't",
  "couldn't", "shouldn't", "isn't", "aren't", "wasn't", "weren't",
  "haven't", "hasn't", "hadn't",
]);

// Multi-word phrases that map to single signs
const PHRASES = [
  { words: ['thank', 'you'], sign: 'thank you' },
  { words: ['good', 'morning'], sign: 'good morning' },
  { words: ['good', 'afternoon'], sign: 'good afternoon' },
  { words: ['good', 'evening'], sign: 'good evening' },
  { words: ['good', 'night'], sign: 'good night' },
  { words: ['how', 'are', 'you'], sign: 'how are you' },
  { words: ['my', 'name'], sign: 'my name' },
  { words: ['nice', 'to', 'meet', 'you'], sign: 'nice to meet you' },
  { words: ['excuse', 'me'], sign: 'excuse me' },
  { words: ['i', 'love', 'you'], sign: 'i love you' },
];

// Contractions / negation expansion
const CONTRACTION_MAP = {
  "don't": ['not'],
  "doesn't": ['not'],
  "didn't": ['not'],
  "won't": ['not'],
  "wouldn't": ['not'],
  "can't": ['not'],
  "couldn't": ['not'],
  "shouldn't": ['not'],
  "isn't": ['not'],
  "aren't": ['not'],
  "wasn't": ['not'],
  "weren't": ['not'],
  "haven't": ['not'],
  "hasn't": ['not'],
  "hadn't": ['not'],
  "i'm": ['i'],
  "i've": ['i'],
  "i'll": ['i'],
  "i'd": ['i'],
  "you're": ['you'],
  "you've": ['you'],
  "you'll": ['you'],
  "you'd": ['you'],
  "he's": ['he'],
  "he'll": ['he'],
  "he'd": ['he'],
  "she's": ['she'],
  "she'll": ['she'],
  "she'd": ['she'],
  "we're": ['we'],
  "we've": ['we'],
  "we'll": ['we'],
  "we'd": ['we'],
  "they're": ['they'],
  "they've": ['they'],
  "they'll": ['they'],
  "they'd": ['they'],
  "that's": ['that'],
  "there's": ['there'],
  "here's": ['here'],
  "what's": ['what'],
  "where's": ['where'],
  "who's": ['who'],
  "let's": ['we'],
};

/**
 * Parse an English sentence into SgSL gloss tokens.
 * Returns: [{ sign: string, nmm: string|null }, ...]
 */
export function parseSentence(text) {
  if (!text || !text.trim()) return [];

  // Detect question
  const isQuestion = text.trim().endsWith('?') ||
    QUESTION_WORDS.has(text.trim().split(/\s+/)[0].toLowerCase().replace(/[?.,!]/g, ''));

  // Detect negation
  const lowerText = text.toLowerCase();
  const hasNegation = [...NEGATION_WORDS].some(w => lowerText.includes(w));

  // Tokenize
  let words = text
    .toLowerCase()
    .replace(/[.,!;:'"()\[\]{}]/g, '')
    .replace(/\?/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0);

  // Expand contractions
  const expanded = [];
  for (const w of words) {
    if (CONTRACTION_MAP[w]) {
      expanded.push(...CONTRACTION_MAP[w]);
    } else {
      expanded.push(w);
    }
  }
  words = expanded;

  // Match multi-word phrases first
  const tokens = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (const phrase of PHRASES) {
      const slice = words.slice(i, i + phrase.words.length);
      if (slice.length === phrase.words.length &&
          slice.every((w, j) => w === phrase.words[j])) {
        tokens.push(phrase.sign);
        i += phrase.words.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      tokens.push(words[i]);
      i++;
    }
  }

  // Separate time markers, content words, question words
  const timeTokens = [];
  const questionTokens = [];
  const contentTokens = [];
  const negationTokens = [];

  for (const token of tokens) {
    const w = token.split(' ')[0]; // first word for multi-word check
    if (NEGATION_WORDS.has(token) || NEGATION_WORDS.has(w)) {
      negationTokens.push(token);
    } else if (TIME_WORDS.has(w)) {
      timeTokens.push(token);
    } else if (QUESTION_WORDS.has(w)) {
      questionTokens.push(token);
    } else if (!DROP_WORDS.has(token)) {
      contentTokens.push(token);
    }
  }

  // SgSL word order: TIME + TOPIC/CONTENT + QUESTION-WORD + NEGATION
  // Topic-comment: roughly keep subject-object but move verb toward end
  // Simple heuristic: if there are 3+ content words, move last word (likely verb) to end
  const reordered = [];

  // Time first
  reordered.push(...timeTokens);

  // Content (with basic topic-comment reordering)
  if (contentTokens.length >= 3) {
    // Heuristic: first word is subject, last is verb, middle is object
    // SgSL: OBJECT SUBJECT VERB
    const subject = contentTokens[0];
    const verb = contentTokens[contentTokens.length - 1];
    const middle = contentTokens.slice(1, -1);
    reordered.push(...middle, subject, verb);
  } else {
    reordered.push(...contentTokens);
  }

  // Question word at end (SgSL places WH-words at end)
  if (isQuestion) {
    reordered.push(...questionTokens);
  }

  // Negation — add NOT sign
  if (hasNegation && !reordered.includes('not')) {
    reordered.push('not');
  }

  // Build output with NMM annotations
  const result = reordered.map(sign => {
    let nmm = null;
    if (isQuestion) nmm = 'question';
    else if (hasNegation) nmm = 'negation';
    return { sign, nmm };
  });

  return result;
}

/**
 * Get available sign labels that exist in the library
 * for vocabulary coverage feedback.
 */
export function getGlossInfo(tokens, availableLabels) {
  const labelSet = new Set(availableLabels.map(l => l.toLowerCase()));
  return tokens.map(t => ({
    ...t,
    available: labelSet.has(t.sign.toLowerCase()),
  }));
}
