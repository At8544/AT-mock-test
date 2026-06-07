import { Question } from './types';
// @ts-ignore
import krutidevToUnicode from '@anthro-ai/krutidev-unicode';

/**
 * Intelligent, multi-strategy HTML Parse Engine for MCQ mock tests.
 */
export async function parseHtmlToQuestions(htmlContent: string, targetExam: string): Promise<Question[]> {
  let questions: Question[] = [];

  // Strategy 0: Check if mock test is a dynamic script key-value quiz format loader
  questions = await tryExtractQuestionsFromScripts(htmlContent, targetExam);

  if (questions.length === 0) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, 'text/html');

    const cleanDoc = doc.cloneNode(true) as Document;
    cleanDoc.querySelectorAll('script, style, meta, link, head, iframe, svg, noscript').forEach(el => el.remove());

    // Strategy 1: Check form input radio elements
    questions = tryFormRadioParsing(cleanDoc, targetExam);

    if (questions.length < 5) {
      // Strategy 2: Structured DOM Traversal
      questions = tryStructuredDomParsing(cleanDoc, targetExam);
    }

    if (questions.length < 5) {
      // Strategy 3: Text Heuristics line scanning
      questions = tryTextHeuristicParsing(cleanDoc, targetExam);
    }
  }

  // Post-processing: convert legacy Kruti Dev Hindi fonts to Unicode if detected
  const processedQuestions = questions.map(q => {
    return {
      ...q,
      question: safeConvertKrutiDev(q.question),
      options: q.options.map(opt => safeConvertKrutiDev(opt)),
      explanation: safeConvertKrutiDev(q.explanation || '')
    };
  });

  return processedQuestions;
}

// ... Keep existing extractQuestionNumberAndBody & stripHtmlTags ...

/**
 * Strategy 0: Parse Script tags.
 */
async function tryExtractQuestionsFromScripts(htmlContent: string, targetExam: string): Promise<Question[]> {
  const questions: Question[] = [];
  const urlMatches: string[] = [];
  
  const jsonUrlRegexes = [
    /const\s+JSON_URL\s*=\s*["']([^"']+)["']/i,
    /fetch\s*\(\s*["']([^"']+)["']/i,
    /["'](https?:\/\/[^"'\s]+?\.json[^"'\s]*?)["']/gi
  ];
  
  for (const regex of jsonUrlRegexes) {
    if (regex.global) {
      let m;
      while ((m = regex.exec(htmlContent)) !== null) {
        if (m[1] && !urlMatches.includes(m[1])) {
          urlMatches.push(m[1]);
        }
      }
    } else {
      const m = htmlContent.match(regex);
      if (m && m[1] && !urlMatches.includes(m[1])) {
        urlMatches.push(m[1]);
      }
    }
  }

  for (const remoteUrl of urlMatches) {
    try {
      let rawData: any = null;
      const proxyUrl = `/api/proxy-json-url?url=${encodeURIComponent(remoteUrl)}`;
      try {
        const response = await fetch(proxyUrl);
        if (response.ok) {
          rawData = await response.json();
        }
      } catch (proxyErr) {
        console.warn("Proxy download failed. Retrying direct browser fetch...", proxyErr);
      }

      if (!rawData) {
        try {
          const response = await fetch(remoteUrl);
          if (response.ok) {
            rawData = await response.json();
          }
        } catch (directErr) {
          console.error("Direct download blocked too.", directErr);
        }
      }

      if (rawData) {
        let items: any[] = [];
        if (Array.isArray(rawData)) {
          items = rawData;
        } else if (rawData.data && Array.isArray(rawData.data)) {
          items = rawData.data;
        } else if (rawData.questions && Array.isArray(rawData.questions)) {
          items = rawData.questions;
        } else {
          for (const key in rawData) {
            if (Array.isArray(rawData[key])) {
              items = rawData[key];
              break;
            }
          }
        }

        if (items.length > 0) {
          items.forEach((item, idx) => {
            const rawQuestion = item.question || item.q || item.title || item.text || item.questionText;
            if (!rawQuestion) return;

            const questionText = stripHtmlTags(rawQuestion);
            if (!questionText.trim()) return;

            let opts: string[] = [];
            if (Array.isArray(item.options || item.choices || item.answers)) {
              opts = item.options || item.choices || item.answers;
            } else {
              for (let i = 1; i <= 10; i++) {
                const optVal = item[`option_${i}`] || item[`option${i}`] || item[`choice_${i}`] || item[`opt_${i}`];
                if (optVal !== undefined && String(optVal).trim()) {
                  opts.push(String(optVal));
                }
              }
            }

            const cleanOpts = opts.map(o => stripHtmlTags(o));

            const ans = item.answer || item.correct || item.correctIndex || item.correctAnswer || item.ans;
            let correctOptionIdx = 0;
            if (ans !== undefined) {
              if (typeof ans === 'number') {
                if (ans >= 1 && ans <= 10) {
                  correctOptionIdx = ans - 1;
                } else {
                  correctOptionIdx = ans;
                }
              } else if (typeof ans === 'string') {
                const trimmedAns = ans.trim();
                const numVal = parseInt(trimmedAns);
                if (!isNaN(numVal) && numVal >= 1 && numVal <= 10) {
                  correctOptionIdx = numVal - 1;
                } else {
                  const cleanedTerm = trimmedAns.toLowerCase();
                  const foundIndex = cleanOpts.findIndex(opt => opt.toLowerCase().trim() === cleanedTerm);
                  if (foundIndex !== -1) {
                    correctOptionIdx = foundIndex;
                  } else {
                    const symbol = cleanedTerm.toUpperCase();
                    if (symbol === 'A' || symbol === 'अ' || symbol === 'ए' || symbol === '1' || symbol === 'क') correctOptionIdx = 0;
                    else if (symbol === 'B' || symbol === 'ब' || symbol === 'बी' || symbol === '2' || symbol === 'ख') correctOptionIdx = 1;
                    else if (symbol === 'C' || symbol === 'स' || symbol === 'सी' || symbol === '3' || symbol === 'ग') correctOptionIdx = 2;
                    else if (symbol === 'D' || symbol === 'द' || symbol === 'डी' || symbol === '4' || symbol === 'घ') correctOptionIdx = 3;
                  }
                }
              }
            }

            const rawExplanation = item.solution || item.solution_text || item.explanation || item.exp || item.desc || '';
            const explanationText = stripHtmlTags(rawExplanation) || 'Extracted from HTML mock test context.';

            questions.push(buildQuestionObject(
              `inj-remote-${Date.now()}-${idx}-${Math.random().toString(36).substring(4)}`,
              questionText,
              cleanOpts,
              correctOptionIdx,
              targetExam,
              explanationText
            ));
          });
        }
      }
    } catch (e) {
      console.error("Failed executing remote dynamic script scraper:", e);
    }
  }

  // Extract locally stored literal array arrays in target script allocations
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(htmlContent)) !== null) {
    const scriptContent = match[1];
    
    // Specifically search for the "questions =" declaration start index
    const questionsStartRegex = /(?:const|let|var)?\s*questions\s*=\s*\[/i;
    const qMatch = questionsStartRegex.exec(scriptContent);
    let arrayStr: string | null = null;

    if (qMatch) {
      const bracketStartIdx = qMatch.index + qMatch[0].length - 1; // Points to '['
      arrayStr = findBalancedBracketBlock(scriptContent, bracketStartIdx);
    }

    if (!arrayStr) {
      const genericStartRegex = /(?:const|let|var)?\s*([a-zA-Z0-9_]+)\s*=\s*\[/gi;
      let genMatch;
      while ((genMatch = genericStartRegex.exec(scriptContent)) !== null) {
        const bracketStartIdx = genMatch.index + genMatch[0].length - 1;
        const potentialArray = findBalancedBracketBlock(scriptContent, bracketStartIdx);
        if (potentialArray && potentialArray.includes('question') && (potentialArray.includes('answer') || potentialArray.includes('option_1'))) {
          arrayStr = potentialArray;
          break;
        }
      }
    }

    if (arrayStr) {
      try {
        const parsed = (new Function(`return ${arrayStr}`))();
        if (Array.isArray(parsed) && parsed.length > 0) {
          parsed.forEach((item, idx) => {
            const rawQuestion = item.question || item.q || item.title || item.text || item.questionText;
            if (!rawQuestion) return;

            const questionText = stripHtmlTags(rawQuestion);
            if (!questionText.trim()) return;

            let opts: string[] = [];
            if (Array.isArray(item.options || item.choices || item.answers)) {
              opts = item.options || item.choices || item.answers;
            } else {
              for (let i = 1; i <= 10; i++) {
                const optVal = item[`option_${i}`] || item[`option${i}`] || item[`choice_${i}`] || item[`opt_${i}`];
                if (optVal !== undefined && String(optVal).trim()) {
                  opts.push(String(optVal));
                }
              }
            }

            const cleanOpts = opts.map(o => stripHtmlTags(o));

            const ans = item.answer || item.correct || item.correctIndex || item.correctAnswer || item.ans;
            let correctOptionIdx = 0;
            if (ans !== undefined) {
              if (typeof ans === 'number') {
                if (ans >= 1 && ans <= 10) {
                  correctOptionIdx = ans - 1;
                } else {
                  correctOptionIdx = ans;
                }
              } else if (typeof ans === 'string') {
                const trimmedAns = ans.trim();
                const numVal = parseInt(trimmedAns);
                if (!isNaN(numVal) && numVal >= 1 && numVal <= 10) {
                  correctOptionIdx = numVal - 1;
                } else {
                  const cleanedTerm = trimmedAns.toLowerCase();
                  const foundIndex = cleanOpts.findIndex(opt => opt.toLowerCase().trim() === cleanedTerm);
                  if (foundIndex !== -1) {
                    correctOptionIdx = foundIndex;
                  } else {
                    const symbol = cleanedTerm.toUpperCase();
                    if (symbol === 'A' || symbol === 'अ' || symbol === 'ए' || symbol === '1' || symbol === 'क') correctOptionIdx = 0;
                    else if (symbol === 'B' || symbol === 'ब' || symbol === 'बी' || symbol === '2' || symbol === 'ख') correctOptionIdx = 1;
                    else if (symbol === 'C' || symbol === 'स' || symbol === 'सी' || symbol === '3' || symbol === 'ग') correctOptionIdx = 2;
                    else if (symbol === 'D' || symbol === 'द' || symbol === 'डी' || symbol === '4' || symbol === 'घ') correctOptionIdx = 3;
                  }
                }
              }
            }

            const rawExplanation = item.solution || item.solution_text || item.explanation || item.exp || item.desc || '';
            const explanationText = stripHtmlTags(rawExplanation) || 'Extracted from HTML mock test context.';

            questions.push(buildQuestionObject(
              `inj-local-${Date.now()}-${idx}-${Math.random().toString(36).substring(4)}`,
              questionText,
              cleanOpts,
              correctOptionIdx,
              targetExam,
              explanationText
            ));
          });
        }
      } catch (err) {
        console.error("Local script evaluation error:", err);
      }
    }
  }

  return questions;
}

// ... Keep existing strategies/util functions ...

/**
 * Robust balanced bracket locator scanner.
 * Evaluates character by character to correctly locate matching brackets.
 */
function findBalancedBracketBlock(content: string, startIdx: number): string | null {
  if (startIdx < 0 || startIdx >= content.length || content[startIdx] !== '[') return null;
  
  let depth = 0;
  let inString: string | null = null;
  let isEscaped = false;
  let inSingleLineComment = false;
  let inBlockComment = false;

  for (let i = startIdx; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1] || '';

    if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inSingleLineComment) {
      if (char === '\n' || char === '\r') {
        inSingleLineComment = false;
      }
      continue;
    }

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === '\\') {
      isEscaped = true;
      continue;
    }

    if (inString) {
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '/' && nextChar === '/') {
      inSingleLineComment = true;
      i++;
      continue;
    }
    if (char === '/' && nextChar === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }

    if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth--;
      if (depth === 0) {
        return content.substring(startIdx, i + 1);
      }
    }
  }

  return null;
}

/**
 * Intelligent legacy font detector.
 */
function isProbablyKrutiDev(text: string | null | undefined): boolean {
  if (!text) return false;
  
  const hindiUnicodeRegex = /[\u0900-\u097F]/;
  if (hindiUnicodeRegex.test(text)) {
    return false;
  }

  const words = text.toLowerCase().split(/\s+/);
  const EnglishCommonWords = new Set([
    "the", "and", "is", "of", "to", "in", "it", "you", "that", "he", "was", "for", "on", "are", "as", "with", "his", "they",
    "at", "be", "this", "have", "from", "or", "one", "had", "by", "word", "but", "not", "what", "all", "were", "we", "when",
    "your", "can", "said", "there", "use", "an", "each", "which", "she", "do", "how", "their", "if", "will", "up", "other",
    "about", "out", "many", "then", "them", "these", "so", "some", "her", "would", "make", "like", "him", "into", "time",
    "has", "look", "two", "more", "write", "go", "see", "number", "no", "way", "could", "people", "my", "than", "first",
    "water", "been", "called", "who", "am", "its", "now", "find", "long", "down", "day", "did", "get", "come", "made",
    "may", "part", "question", "answer", "options", "solution", "explanation"
  ]);

  let englishWordMatches = 0;
  for (const w of words) {
    if (EnglishCommonWords.has(w)) {
      englishWordMatches++;
    }
  }

  if (englishWordMatches > 1 && words.length > 3) {
    return false;
  }

  if (text.includes("vfXudq") || text.includes("mRiUu") || text.includes("jktiwr") || text.includes("oa'k") || text.includes("ugha") || text.includes("Fkk")) {
    return true;
  }

  let krutiDevCharCount = 0;
  const krutiDevChars = /[vdkjlsfhrtea']/g;
  const matches = text.match(krutiDevChars);
  if (matches) {
    krutiDevCharCount = matches.length;
  }

  const lettersOnly = text.replace(/[^a-zA-Z]/g, "");
  if (lettersOnly.length > 0) {
    const ratio = krutiDevCharCount / lettersOnly.length;
    if (ratio >= 0.6 && lettersOnly.length >= 4) {
      return true;
    }
  }

  return false;
}

/**
 * Converts legacy Kruti Dev text to 100% correct Unicode Hindi.
 */
function safeConvertKrutiDev(text: string): string {
  if (!text) return "";
  if (isProbablyKrutiDev(text)) {
    try {
      const converter = typeof krutidevToUnicode === 'function' 
        ? krutidevToUnicode 
        : (krutidevToUnicode as any).default || krutidevToUnicode;
      
      if (typeof converter === 'function') {
        return converter(text);
      }
    } catch (e) {
      console.error("Error/fallback in safeConvertKrutiDev converter pipeline:", e);
    }
  }
  return text;
}
