import { Question } from './types';
// @ts-ignore
import krutidevToUnicode from '@anthro-ai/krutidev-unicode';


/**
 * Intelligent, multi-strategy HTML Parse Engine for MCQ mock tests.
 * Extracts questions, options, correct answers, and explanations.
 * Supporting synchronous DOM parses alongside asynchronous JSON/Script retrievals.
 */
export async function parseHtmlToQuestions(htmlContent: string, targetExam: string): Promise<Question[]> {
  let questions: Question[] = [];

  // Strategy 0: Check if mock test is a dynamic script key-value quiz format loader
  questions = await tryExtractQuestionsFromScripts(htmlContent, targetExam);

  if (questions.length === 0) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, 'text/html');

    // Remove elements that are noise for HTML structure
    const cleanDoc = doc.cloneNode(true) as Document;
    cleanDoc.querySelectorAll('script, style, meta, link, head, iframe, svg, noscript').forEach(el => el.remove());

    // Strategy 1: Check form input radio elements
    questions = tryFormRadioParsing(cleanDoc, targetExam);

    if (questions.length < 5) {
      // Strategy 2: Structured DOM Traversal (lists, blocks, grids)
      questions = tryStructuredDomParsing(cleanDoc, targetExam);
    }

    if (questions.length < 5) {
      // Strategy 3: Text Heuristics line scanning (Most Resilient Fallback)
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

/**
 * Helper to parse clean question number and body.
 */
function extractQuestionNumberAndBody(text: string): { num: number | null; body: string } {
  const cleanText = text.trim();
  // Standard formats: "Question 5: What is...", "Q55. Why...", "प्र. 5: ", "प्रश्न 6- "
  const questionPrefixRegex = /^\s*(?:[Qq]uestion|[Qq]\s*\.?|[Pp]rashna|[प्प्र]श्न|[प्प्र]\s*\.?)\s*(\d+)\s*[\.\):\-\s]+/i;
  let match = cleanText.match(questionPrefixRegex);
  if (match) {
    const num = parseInt(match[1]);
    const body = cleanText.substring(match[0].length).trim();
    return { num, body };
  }

  // Numerals fallback: "1. Under which article...", "101) Name of..."
  const literalNumRegex = /^\s*(\d+)\s*[\.\):\-\sऽ]+\s*/;
  match = cleanText.match(literalNumRegex);
  if (match) {
    const num = parseInt(match[1]);
    const body = cleanText.substring(match[0].length).trim();
    return { num, body };
  }

  return { num: null, body: cleanText };
}

/**
 * Utility to strip HTML tags, especially style, script and header metadata tags
 * so questions render cleanly as pure, human-usable text content.
 */
function stripHtmlTags(html: string): string {
  if (!html) return '';
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('style, script, head, link, meta, title').forEach(el => el.remove());
    return (doc.body.textContent || doc.body.innerText || '').trim();
  } catch (e) {
    // Basic fallback if context doesn't support DOMParser
    return html.replace(/<[^>]*>/g, '').trim();
  }
}

/**
 * Strategy 0: Parse Script tags.
 * Extract questions array assigned directly as a JS array keyword block or fetched from remote JSON URL.
 */
async function tryExtractQuestionsFromScripts(htmlContent: string, targetExam: string): Promise<Question[]> {
  const questions: Question[] = [];
  const urlMatches: string[] = [];
  
  // Scrape any URL blocks pointing to .json files inside the html upload
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

  // If remote urls are detected, run high-eligibility download pipeline through secure Node CORS proxy first
  for (const remoteUrl of urlMatches) {
    try {
      console.log("War-Proof XML/HTTP Parser retrieved remote dynamic reference:", remoteUrl);
      let rawData: any = null;
      
      // Fetch using client backend proxy route to guarantee bypassing cross-domain restrictions
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
        // Fallback directly
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

            // Map correct option value indexes beautifully
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

    // Fallback: list of potential variables that hold question list arrays
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
        console.error("Error evaluating scripts inside tryExtractQuestionsFromScripts:", err);
      }
    }
  }

  return questions;
}

/**
 * Strategy 1: Form Radio Group Parsing
 */
function tryFormRadioParsing(doc: Document, targetExam: string): Question[] {
  const questions: Question[] = [];
  const radioInputs = doc.querySelectorAll('input[type="radio"]');
  const groups: Record<string, HTMLInputElement[]> = {};

  radioInputs.forEach(input => {
    const name = input.getAttribute('name');
    if (name) {
      if (!groups[name]) groups[name] = [];
      groups[name].push(input as HTMLInputElement);
    }
  });

  const names = Object.keys(groups);
  names.forEach((name, index) => {
    const inputs = groups[name];
    if (inputs.length < 2) return;

    const options: string[] = [];
    let correctIdx = 0;

    inputs.forEach((input, optIdx) => {
      let optText = '';
      const id = input.getAttribute('id');
      if (id) {
        const label = doc.querySelector(`label[for="${id}"]`);
        if (label) optText = label.textContent || '';
      }
      
      if (!optText.trim()) {
        const nextSibling = input.nextSibling;
        if (nextSibling && nextSibling.textContent?.trim()) {
          optText = nextSibling.textContent;
        } else if (input.parentElement) {
          optText = input.parentElement.textContent || '';
          optText = optText.replace(/^[A-Da-d1-4अबसदएबीसीडीकखगघ१२३४][\.\)\-\s]/, '');
        }
      }

      const cleanOpt = cleanText(optText);
      options.push(cleanOpt || `Option ${optIdx + 1}`);

      const isChecked = input.hasAttribute('checked') || input.checked;
      const isSuccessClass = input.classList.contains('correct') || input.parentElement?.classList.contains('correct') || input.parentElement?.classList.contains('answer');
      if (isChecked || isSuccessClass) {
        correctIdx = optIdx;
      }
    });

    const firstInput = inputs[0];
    let questionText = '';
    let container: HTMLElement | null = firstInput.parentElement;
    for (let depth = 0; depth < 4; depth++) {
      if (!container) break;
      const prev = container.previousElementSibling;
      if (prev && prev.textContent?.trim()) {
        questionText = prev.textContent;
        break;
      }
      container = container.parentElement;
    }

    if (!questionText.trim()) {
      questionText = firstInput.parentElement?.textContent?.split('\n')[0] || `Question ${index + 1}`;
    }

    const { body: cleanedBody } = extractQuestionNumberAndBody(questionText);

    if (cleanedBody && options.length >= 2) {
      questions.push(buildQuestionObject(`radio-${index}`, cleanedBody, options, correctIdx, targetExam));
    }
  });

  return questions;
}

/**
 * Strategy 2: Structured DOM matching
 */
function tryStructuredDomParsing(doc: Document, targetExam: string): Question[] {
  const questions: Question[] = [];
  const candidateElements = doc.querySelectorAll('p, li, div, h3, h4, tr');
  const questionNumRegex = /^\s*(?:[Qq]uestion|[Qq]\s*\.?|[Pp]rashna|[प्प्र]श्न|[प्प्र]\s*\.?|[0-9]+)\s*(\d+)?[\.\):\-\sऽ]/i;

  candidateElements.forEach((el, index) => {
    const text = el.textContent || '';
    if (!questionNumRegex.test(text)) return;

    // Skip if it contains inline options (handled by line scanning / heuristic parser better)
    if (text.includes('(A)') && text.includes('(B)')) return;
    if (text.includes('(अ)') && text.includes('(ब)')) return;

    const { body: questionText } = extractQuestionNumberAndBody(text);
    if (questionText.length < 5) return;

    const options: string[] = [];
    let correctIdx = 0;
    const siblingNodes: string[] = [];
    let sibling = el.nextElementSibling;
    
    while (sibling && siblingNodes.length < 6) {
      const sibText = sibling.textContent || '';
      if (questionNumRegex.test(sibText)) break;
      
      const cleanSib = cleanText(sibText);
      if (cleanSib) {
        siblingNodes.push(cleanSib);
        const classStr = (sibling.className || '').toLowerCase();
        if (classStr.includes('correct') || classStr.includes('success') || classStr.includes('selected') || sibling.querySelector('.correct, .selected-answer')) {
          correctIdx = siblingNodes.length - 1;
        }
      }
      sibling = sibling.nextElementSibling;
    }

    const optionPrefix = /^[A-Da-d1-4अबसदएबीसीडीकखगघ१२३४\(\[\]][\.\)\-\s]/;
    const cleanOptions = siblingNodes.filter(s => optionPrefix.test(s));
    const finalOptions = cleanOptions.length >= 2 ? cleanOptions : siblingNodes.slice(0, 4);

    if (finalOptions.length >= 2) {
      const sanitizedOptions = finalOptions.map(opt => opt.replace(/^[A-Da-d1-4अबसदएबीसीडीकखगघ१२३४\(\[\]]+[\.\)\-\s]*/i, '').trim());
      questions.push(buildQuestionObject(`dom-${index}`, questionText, sanitizedOptions, correctIdx, targetExam));
    }
  });

  return questions;
}

/**
 * Strategy 3: Heuristic Regex Text Parser (The Most Universal Fallback)
 * Converts HTML elements to structured text with linebreaks and groups blocks into custom questions.
 */
function tryTextHeuristicParsing(doc: Document, targetExam: string): Question[] {
  const questions: Question[] = [];
  
  // Custom walker that inserts smart margins
  const walkNodes = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || '';
    }
    let text = '';
    const name = node.nodeName.toLowerCase();
    
    if (name === 'br' || name === 'p' || name === 'div' || name === 'li' || name === 'tr' || name === 'h1' || name === 'h2' || name === 'h3' || name === 'h4' || name === 'option') {
      text += '\n';
    }

    node.childNodes.forEach(child => {
      text += walkNodes(child);
    });

    if (name === 'p' || name === 'div' || name === 'li' || name === 'tr' || name === 'h1' || name === 'h2' || name === 'h3' || name === 'h4') {
      text += '\n';
    }
    return text;
  };

  const fullText = walkNodes(doc.body);
  const lines = fullText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  // We will first extract any global answer key block if present
  const answerKeys = tryExtractAnswerKey(lines);
  console.log("Global Answer Key detected:", answerKeys);

  // Broad matching regexes for identifying sections
  const questionStartRegex = /^\s*(?:[Qq]uestion|[Qq]\s*\.?|Prashna|Q\s*-\s*|[प्प्र]श्न|[प्प्र]\s*\.?)\s*(\d+)/i;
  const literalNumberStartRegex = /^\s*(\d+)\s*[\.\):\-\sऽ]/;

  // Patterns matching an option start eg. "(A) Jaipur", "(अ) जयपुर", "A. Delhi", "1) Bharat"
  const optionPrefixRegex = /^\s*[\(\[]?([A-Da-d1-4अबसदएबीसीडीकखगघ१२३४])[\)\]\.\-\s]\s*(.*)$/i;

  let currentQuestion: string = '';
  let currentQuestionNum: number | null = null;
  let currentOptions: string[] = [];
  let correctOptionIdx = 0;
  let explanation: string = '';
  let isParsingExplanation = false;

  const flushQuestion = (index: number) => {
    if (currentQuestion) {
      let finalOptions = [...currentOptions];

      // If we didn't collect individual option lines but the question contains inline options, extract them
      if (finalOptions.length === 0) {
        const extracted = extractInlineOptions(currentQuestion);
        if (extracted.options.length >= 2) {
          currentQuestion = extracted.questionText;
          finalOptions = extracted.options;
          correctOptionIdx = extracted.correctIdx;
        }
      }

      // Format individual collected options to remove option labels
      const formattedOptions = finalOptions.map(opt => {
        return opt.replace(/^[\(\[\]]?\s*([A-Da-d1-4अबसदएबीसीडीकखगघ१२३४])\s*[\)\]\.\-\sऽ]+/i, '').trim();
      });

      // Override correct answer with global answer keys if found
      if (currentQuestionNum !== null && answerKeys[currentQuestionNum] !== undefined) {
        correctOptionIdx = answerKeys[currentQuestionNum];
      }

      // Only push if we have at least 2 potential options
      if (formattedOptions.length >= 2) {
        questions.push(buildQuestionObject(
          `heuristic-${Date.now()}-${index}-${Math.random().toString(36).substring(4)}`,
          currentQuestion,
          formattedOptions,
          correctOptionIdx,
          targetExam,
          explanation
        ));
      }
    }
    
    // Reset states
    currentQuestion = '';
    currentQuestionNum = null;
    currentOptions = [];
    correctOptionIdx = 0;
    explanation = '';
    isParsingExplanation = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if line indicates an Answer Key block or starts Answer Key section
    if (/^(?:answer\s*key|answers|उत्तरमाला|उत्तर\s*कुंजी|उत्तर\s*तालिका|key)/i.test(line)) {
      // Once we reach global answer keys, we can stop parsing questions
      flushQuestion(i);
      break;
    }

    // Check if line is a question start
    const isQuestionStart = questionStartRegex.test(line) || literalNumberStartRegex.test(line);

    if (isQuestionStart) {
      flushQuestion(i);
      const { num, body } = extractQuestionNumberAndBody(line);
      currentQuestion = body;
      currentQuestionNum = num;
      continue;
    }

    // Check if line indicates correct answer (inline fallback)
    const ansLower = line.toLowerCase();
    const isAnsLine = ansLower.startsWith('ans') || 
                      ansLower.startsWith('correct') || 
                      ansLower.startsWith('answer') || 
                      ansLower.startsWith('उत्तर') || 
                      ansLower.startsWith('उत्तर:');

    if (isAnsLine && currentQuestion) {
      // Match options or numerals or characters
      const match = line.match(/(?:[aA]ns|[cC]orrect|[aA]nswer|[उउ]त्तर|:)\s*[\(\[\s]*([A-Da-d1-4अबसदएबीसीडीकखगघ१२३४])[\)\]\s]*/);
      if (match && match[1]) {
        const symbol = match[1].toUpperCase();
        if (symbol === 'A' || symbol === '1' || symbol === 'अ' || symbol === 'ए' || symbol === 'क') correctOptionIdx = 0;
        else if (symbol === 'B' || symbol === '2' || symbol === 'ब' || symbol === 'बी' || symbol === 'ख') correctOptionIdx = 1;
        else if (symbol === 'C' || symbol === '3' || symbol === 'स' || symbol === 'सी' || symbol === 'ग') correctOptionIdx = 2;
        else if (symbol === 'D' || symbol === '4' || symbol === 'द' || symbol === 'डी' || symbol === 'घ') correctOptionIdx = 3;
      }
      isParsingExplanation = true;
      continue;
    }

    // Check if line is Option line
    if (optionPrefixRegex.test(line) && currentQuestion && !isParsingExplanation) {
      // Check for inline multi-choices inside same line
      if (line.includes('(B)') || line.includes('(ब)') || line.includes('(ख)')) {
        const inlineOpts = Array.from(line.matchAll(/[\(\[]?([A-Da-d1-4अबसदएबीसीडीकखगघ१२३४])[\)\]\.\-\sऽ]+([^\(\[\n]+)/gi));
        if (inlineOpts.length >= 2) {
          inlineOpts.forEach(m => {
            currentOptions.push(m[0].trim());
          });
          continue;
        }
      }
      currentOptions.push(line);
      continue;
    }

    // Parse Explanation
    if (isParsingExplanation && currentQuestion) {
      explanation += (explanation ? ' ' : '') + line;
      continue;
    }

    if (ansLower.startsWith('explanation') || ansLower.startsWith('व्याख्या') || ansLower.startsWith('sol.')) {
      isParsingExplanation = true;
      explanation = line.replace(/^(explanation|व्याख्या|sol\.)\s*:?/i, '').trim();
      continue;
    }

    // Assemble question description body lines
    if (currentQuestion && currentOptions.length === 0 && !isParsingExplanation) {
      // Check if line itself contains inline options
      if ((line.includes('(A)') && line.includes('(B)')) || (line.includes('(अ)') && line.includes('(ब)')) || (line.includes('(क)') && line.includes('(ख)'))) {
        const inlineOpts = Array.from(line.matchAll(/[\(\[]?([A-Da-d1-4अबसदएबीसीडीकखगघ१२३४])[\)\]\.\-\sऽ]+([^\(\[\n]+)/gi));
        if (inlineOpts.length >= 2) {
          inlineOpts.forEach(m => {
            currentOptions.push(m[0].trim());
          });
          continue;
        }
      }
      currentQuestion += '\n' + line;
    }
  }

  flushQuestion(lines.length);

  return questions;
}

/**
 * Parses inline string option layout
 * eg. "Capital is: (A) Jaipur (B) Delhi (C) Udaipur (D) Kota"
 */
function extractInlineOptions(text: string): { questionText: string; options: string[]; correctIdx: number } {
  let questionText = text;
  const options: string[] = [];
  let correctIdx = 0;

  // Pattern 1: (A)/(B)/(C)/(D) or (अ)/(ब)/(स)/(द) or (क)/(ख)/(ग)/(घ)
  const patternA = /[\(\[]?(A|अ|ए|क)[\)\]\.\-\sऽ]+([\s\S]*?)(?=[\(\[]?(B|ब|बी|ख)[\)\]\.\-\sऽ]|$)/gi;
  const patternB = /[\(\[]?(B|ब|बी|ख)[\)\]\.\-\sऽ]+([\s\S]*?)(?=[\(\[]?(C|स|सी|ग)[\)\]\.\-\sऽ]|$)/gi;
  const patternC = /[\(\[]?(C|स|सी|ग)[\)\]\.\-\sऽ]+([\s\S]*?)(?=[\(\[]?(D|द|डी|घ)[\)\]\.\-\sऽ]|$)/gi;
  const patternD = /[\(\[]?(D|द|डी|घ)[\)\]\.\-\sऽ]+([\s\S]*?)(?=$)/gi;

  const matchA = text.match(patternA);
  const matchB = text.match(patternB);
  const matchC = text.match(patternC);
  const matchD = text.match(patternD);

  if (matchA && matchB) {
    options.push(matchA[0].trim());
    options.push(matchB[0].trim());
    if (matchC) options.push(matchC[0].trim());
    if (matchD) options.push(matchD[0].trim());

    const firstOptIdx = text.search(/[\(\[]?(A|अ|ए|क)[\)\]\.\-\sऽ]/i);
    if (firstOptIdx !== -1) {
      questionText = text.substring(0, firstOptIdx).trim();
    }
  } else {
    // Try numerals pattern: (1)/(2)/(3)/(4) or 1./2./3./4. or (१)/(२)/(३)/(४)
    const pattern1 = /[\(\[]?(1|१)[\)\]\.\-\sऽ]+([\s\S]*?)(?=[\(\[]?(2|२)[\)\]\.\-\sऽ]|$)/;
    const pattern2 = /[\(\[]?(2|२)[\)\]\.\-\sऽ]+([\s\S]*?)(?=[\(\[]?(3|३)[\)\]\.\-\sऽ]|$)/;
    const pattern3 = /[\(\[]?(3|३)[\)\]\.\-\sऽ]+([\s\S]*?)(?=[\(\[]?(4|४)[\)\]\.\-\sऽ]|$)/;
    const pattern4 = /[\(\[]?(4|४)[\)\]\.\-\sऽ]+([\s\S]*?)(?=$)/;

    const match1 = text.match(pattern1);
    const match2 = text.match(pattern2);
    const match3 = text.match(pattern3);
    const match4 = text.match(pattern4);

    if (match1 && match2) {
      options.push(match1[0].trim());
      options.push(match2[0].trim());
      if (match3) options.push(match3[0].trim());
      if (match4) options.push(match4[0].trim());

      const firstOptIdx = text.search(/[\(\[]?(1|१)[\)\]\.\-\sऽ]/);
      if (firstOptIdx !== -1) {
        questionText = text.substring(0, firstOptIdx).trim();
      }
    }
  }

  return { questionText, options, correctIdx };
}

/**
 * Smart Answer Key extractor
 */
function tryExtractAnswerKey(lines: string[]): Record<number, number> {
  const answerKey: Record<number, number> = {};
  let isAnswerKeySection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^(?:answer\s*key|answers|उत्तरमाला|उत्तर\s*कुंजी|उत्तर\s*तालिका|key)/i.test(line)) {
      isAnswerKeySection = true;
      continue;
    }

    if (isAnswerKeySection) {
      // Pull matches like: "1 - A" , "2. B" , "3(C)" , "4: A" , "5 - अ" or "10 - (ब)" or "1 - क"
      const matches = Array.from(line.matchAll(/(\d+)\s*[\.\-\:\(]*\s*([A-Da-d1-4अबसदएबीसीडीकखगघ१२३४])\s*[\)\.]?/g));
      matches.forEach(m => {
        const qNum = parseInt(m[1]);
        const val = m[2].trim().toUpperCase();
        let optIdx = 0;
        if (val === 'A' || val === '1' || val === 'अ' || val === 'ए' || val === 'क' || val === '१') optIdx = 0;
        else if (val === 'B' || val === '2' || val === 'ब' || val === 'बी' || val === 'ख' || val === '२') optIdx = 1;
        else if (val === 'C' || val === '3' || val === 'स' || val === 'सी' || val === 'ग' || val === '३') optIdx = 2;
        else if (val === 'D' || val === '4' || val === 'द' || val === 'डी' || val === 'घ' || val === '४') optIdx = 3;
        
        answerKey[qNum] = optIdx;
      });
    }
  }
  return answerKey;
}

/**
 * Text cleanup utilities
 */
function cleanText(text: string): string {
  if (!text) return '';
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Standardized constructor of Question object structure
 */
function buildQuestionObject(
  id: string,
  question: string,
  options: string[],
  correctOptionIndex: number,
  targetExam: string,
  explanationText?: string
): Question {
  let finalOpts = [...options];
  
  if (finalOpts.length < 4) {
    const defaultLabels = ['Option A', 'Option B', 'Option C', 'Option D'];
    while (finalOpts.length < 4) {
      finalOpts.push(defaultLabels[finalOpts.length]);
    }
  } else if (finalOpts.length > 4) {
    finalOpts = finalOpts.slice(0, 4);
  }

  return {
    id,
    question: question.trim(),
    options: finalOpts.map(o => o.trim()),
    correctOptionIndex: correctOptionIndex < 0 || correctOptionIndex > 3 ? 0 : correctOptionIndex,
    explanation: explanationText?.trim() || 'Extracted from HTML mock test context.',
    subject: 'General Knowledge',
    topic: 'Mock Test Ingestion',
    subtopic: 'HTML Ingested MCQ',
    difficulty: 'medium',
    sourceType: 'pyq',
    timesAnswered: 0,
    timesCorrect: 0,
    targetExam: targetExam || 'General Study'
  };
}

/**
 * Robust balanced bracket locator scanner.
 * Evaluates character by character to correctly locate matching brackets.
 * Properly skips single line/block comments, escaped symbols, and string contents.
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

    // Handle block comments
    if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        i++; // skip /
      }
      continue;
    }

    // Handle single-line comments
    if (inSingleLineComment) {
      if (char === '\n' || char === '\r') {
        inSingleLineComment = false;
      }
      continue;
    }

    // Handle escape char
    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === '\\') {
      isEscaped = true;
      continue;
    }

    // Handle string boundaries
    if (inString) {
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    // Detect comment starts
    if (char === '/' && nextChar === '/') {
      inSingleLineComment = true;
      i++; // skip secondary comment char
      continue;
    }
    if (char === '/' && nextChar === '*') {
      inBlockComment = true;
      i++; // skip secondary comment char
      continue;
    }

    // Detect string boundaries
    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }

    // Track brackets depth
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
 * Identifies if a string is written in Kruti Dev font keyboard format instead of Hindi Unicode.
 */
function isProbablyKrutiDev(text: string | null | undefined): boolean {
  if (!text) return false;
  
  // If it already contains Hindi Unicode characters, it is NOT Kruti Dev legato.
  const hindiUnicodeRegex = /[\u0900-\u097F]/;
  if (hindiUnicodeRegex.test(text)) {
    return false;
  }

  // Count common Kruti Dev characters and markers
  let score = 0;
  const words = text.toLowerCase().split(/\s+/);
  
  // Common English words list to rule out English text
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

  // If we match even 1-2 standard English words, it's likely English
  if (englishWordMatches > 1 && words.length > 3) {
    return false;
  }

  // Check for presence of classic Kruti Dev patterns
  if (text.includes("vfXudq") || text.includes("mRiUu") || text.includes("jktiwr") || text.includes("oa'k") || text.includes("ugha") || text.includes("Fkk")) {
    return true;
  }

  // Analyze characters
  let krutiDevCharCount = 0;
  const krutiDevChars = /[vdkjlsfhrtea']/g;
  const matches = text.match(krutiDevChars);
  if (matches) {
    krutiDevCharCount = matches.length;
  }

  // If more than 60% of the characters are popular Kruti Dev layout keys, it's Kruti Dev text
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
