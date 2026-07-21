function stringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function boundedText(value, maxLength = 140) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function normalizeImageAnalysis(value) {
  return {
    titleEn: boundedText(value?.titleEn),
    titleEs: boundedText(value?.titleEs),
    description: typeof value?.description === "string" ? value.description.trim() : "",
    visibleText: typeof value?.visibleText === "string" ? value.visibleText.trim() : "",
    concepts: stringList(value?.concepts),
    keywords: stringList(value?.keywords),
    bodyRegion: boundedText(value?.bodyRegion),
    imageType: boundedText(value?.imageType),
  };
}

export function imageChunks(analysis) {
  const ocrContent = analysis.visibleText;
  const visionContent = [
    analysis.titleEn ? `Title (English): ${analysis.titleEn}` : "",
    analysis.titleEs ? `Título (español): ${analysis.titleEs}` : "",
    analysis.description,
    analysis.imageType ? `Image type: ${analysis.imageType}` : "",
    analysis.bodyRegion ? `Body region: ${analysis.bodyRegion}` : "",
    analysis.concepts.length ? `Concepts: ${analysis.concepts.join(", ")}` : "",
    analysis.keywords.length ? `Keywords: ${analysis.keywords.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    ocrContent ? { sourceType: "image_ocr", content: ocrContent } : null,
    visionContent ? { sourceType: "image_vision", content: visionContent } : null,
  ].filter(Boolean);
}
