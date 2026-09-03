import fs from "node:fs/promises";
import Tesseract from "tesseract.js";

const allowedDocTypes = new Set([
  "passport",
  "drivers_license",
  "national_id",
  "residence_permit",
]);

const documentRules = {
  passport: {
    label: "passport",
    patterns: [
      /passport/i,
      /date\s*of\s*birth|birth/i,
      /nationality|nationality/i,
      /p<\w{3}/i,
    ],
  },
  drivers_license: {
    label: "driver's license",
    patterns: [
      /driver'?s?\s+licen[cs]e/i,
      /licen[cs]e\s*(no|number)/i,
      /date\s*of\s*birth|dob/i,
      /expiry|expiration|expires/i,
    ],
  },
  national_id: {
    label: "national ID",
    patterns: [
      /national\s+id|identity\s+card|national\s+identity/i,
      /id\s*(no|number)|identity\s*(no|number)/i,
      /date\s*of\s*birth|dob/i,
      /surname|given\s+name|full\s+name/i,
    ],
  },
  residence_permit: {
    label: "residence permit",
    patterns: [
      /residen[ct]e\s+permit|residen[ct]e\s+card/i,
      /permit\s*(no|number)|card\s*(no|number)/i,
      /date\s*of\s*birth|dob/i,
      /expiry|expiration|expires/i,
    ],
  },
};

const competingDocumentPatterns = {
  passport:
    /driver'?s?\s+licen[cs]e|national\s+id|identity\s+card|residen[ct]e\s+permit/i,
  drivers_license:
    /passport|national\s+id|identity\s+card|residen[ct]e\s+permit/i,
  national_id: /passport|driver'?s?\s+licen[cs]e|residen[ct]e\s+permit/i,
  residence_permit:
    /passport|driver'?s?\s+licen[cs]e|national\s+id|identity\s+card/i,
};

function isSupportedImage(filePath, mimeType) {
  return fs.stat(filePath).then((stats) => {
    return stats.isFile() && stats.size > 0 && /^image\//i.test(mimeType);
  });
}

export function validateDocumentType(docType) {
  if (!allowedDocTypes.has(docType)) {
    return {
      isValid: false,
      rejectionReason:
        "Unsupported document type. Acceptable options: passport, drivers_license, national_id, or residence_permit.",
    };
  }

  return { isValid: true, rejectionReason: null };
}

export async function runOcr(filePath) {
  try {
    const result = await Tesseract.recognize(filePath, "eng", {
      logger: (m) => {
        if (m.status === "recognizing text") {
          // no-op to keep OCR output quiet
        }
      },
    });

    const text = result.data?.text || "";
    const confidence = result.data?.confidence || 0;

    return {
      text,
      confidence: Number(confidence) || 0,
    };
  } catch (error) {
    console.error("OCR failed:", error);
    return { text: "", confidence: 0 };
  }
}

export function evaluateKycDocument({
  docType,
  ocrText,
  ocrConfidence,
  imageValid,
}) {
  const typeCheck = validateDocumentType(docType);
  if (!typeCheck.isValid) {
    return {
      isValid: false,
      rejectionReason: typeCheck.rejectionReason,
      confidence: 0,
    };
  }

  if (!imageValid) {
    return {
      isValid: false,
      rejectionReason: "The uploaded file is not a valid supported image.",
      confidence: 0,
    };
  }

  const cleanedText = (ocrText || "").replace(/\s+/g, " ").trim();
  const matches = documentRules[docType].patterns.filter((pattern) =>
    pattern.test(cleanedText),
  ).length;
  const patternConfidence = Math.round(
    (matches / documentRules[docType].patterns.length) * 100,
  );
  const confidence = Math.round(ocrConfidence * 0.6 + patternConfidence * 0.4);

  return {
    isValid: true,
    rejectionReason: "Document requires admin review.",
    confidence,
    needsReview: true,
  };
}

export async function processKycUpload({ filePath, docType, mimeType }) {
  const imageValid = await isSupportedImage(filePath, mimeType);
  const { text, confidence } = await runOcr(filePath);
  const evaluation = evaluateKycDocument({
    docType,
    ocrText: text,
    ocrConfidence: confidence,
    imageValid,
  });

  return {
    ...evaluation,
    ocrText: text,
    confidence: evaluation.confidence || confidence,
  };
}

export async function removeKycFile(filePath) {
  await fs.unlink(filePath).catch(() => null);
}
