// content.js
function getMainText() {
  const paragraphs = document.querySelectorAll("p");
  return Array.from(paragraphs).map(p => p.innerText).join(" \n");
}

function computeTFIDF(text) {
  const sentences = text.match(/[^.!?]+[.!?]/g) || [];
  const words = text.toLowerCase().match(/\b\w+\b/g) || [];
  const wordFreq = {};
  words.forEach(word => wordFreq[word] = (wordFreq[word] || 0) + 1);
  
  const sentenceScores = sentences.map(sentence => {
    const sentenceWords = sentence.toLowerCase().match(/\b\w+\b/g) || [];
    let score = sentenceWords.reduce((sum, word) => sum + (wordFreq[word] || 0), 0);
    return { sentence, score };
  });
  
  sentenceScores.sort((a, b) => b.score - a.score);
  return sentenceScores.slice(0, Math.max(1, sentenceScores.length * 0.3));
}

function highlightSentences(importantSentences) {
  document.querySelectorAll("p").forEach(p => {
    importantSentences.forEach(({ sentence }) => {
      if (p.innerText.includes(sentence.trim())) {
        p.innerHTML = p.innerHTML.replace(sentence.trim(), `<span style='background-color: yellow;'>${sentence.trim()}</span>`);
      }
    });
  });
}

const text = getMainText();
const importantSentences = computeTFIDF(text);
highlightSentences(importantSentences);
