const PAYWALL_PATTERNS = [/subscribe/i, /sign in/i, /subscriber/i, /paywall/i, /create an account/i];
const NAV_PATTERNS = [/home/i, /menu/i, /newsletter/i, /privacy/i, /terms/i, /advertisement/i, /related/i];

function evaluateExtractionQuality(article = {}) {
  const text = normalize(article.textContent || stripHtml(article.content || ""));
  const title = normalize(article.title || "");
  const contentHtml = article.content || "";
  const lengthScore = clamp(text.length / 4500);
  const density = text.length / Math.max(contentHtml.length, 1);
  const densityScore = clamp(density / 0.45);
  const duplicationRatio = estimateDuplicationRatio(text);
  const boilerplateRatio = estimatePatternRatio(text, NAV_PATTERNS);
  const paywallRatio = estimatePatternRatio(text, PAYWALL_PATTERNS);
  const consistencyScore = title ? titleBodyConsistency(title, text) : 0.7;
  const contaminationPenalty = clamp(duplicationRatio * 0.35 + boilerplateRatio * 0.35 + paywallRatio * 0.5);

  const qualityScore = clamp(
    lengthScore * 0.28 +
      densityScore * 0.22 +
      consistencyScore * 0.2 +
      (1 - duplicationRatio) * 0.15 +
      (1 - boilerplateRatio) * 0.1 +
      (1 - paywallRatio) * 0.05 -
      contaminationPenalty * 0.2
  );

  return {
    qualityScore: Number(qualityScore.toFixed(2)),
    contentLength: text.length,
    textDensity: Number(density.toFixed(3)),
    duplicationRatio: Number(duplicationRatio.toFixed(2)),
    boilerplateRatio: Number(boilerplateRatio.toFixed(2)),
    paywallContamination: Number(paywallRatio.toFixed(2)),
    titleBodyConsistency: Number(consistencyScore.toFixed(2)),
    acceptable: qualityScore >= 0.52 && text.length >= 850 && paywallRatio < 0.12
  };
}

function estimateDuplicationRatio(text) {
  const paragraphs = text.split(/(?<=[.!?。！？])\s+/).map((item) => item.trim()).filter((item) => item.length > 60);
  if (paragraphs.length < 3) return 0;
  const seen = new Set();
  let duplicates = 0;
  for (const paragraph of paragraphs) {
    const key = paragraph.slice(0, 120).toLowerCase();
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
  }
  return duplicates / paragraphs.length;
}

function estimatePatternRatio(text, patterns) {
  if (!text) return 0;
  const sentences = text.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  if (!sentences.length) return 0;
  return sentences.filter((sentence) => patterns.some((pattern) => pattern.test(sentence))).length / sentences.length;
}

function titleBodyConsistency(title, body) {
  const words = new Set(title.toLowerCase().split(/\W+/).filter((word) => word.length > 3));
  if (!words.size) return 0.7;
  const bodyLower = body.toLowerCase();
  let hits = 0;
  for (const word of words) {
    if (bodyLower.includes(word)) hits += 1;
  }
  return clamp(hits / words.size);
}

function stripHtml(html = "") {
  return html.replace(/<[^>]+>/g, " ");
}

function normalize(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

module.exports = {
  evaluateExtractionQuality
};
