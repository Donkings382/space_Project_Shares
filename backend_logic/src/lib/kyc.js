import fs from "node:fs/promises";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

export async function processKycUpload({ filePath, mimeType }) {
  const stats = await fs.stat(filePath);
  const isImage = /^image\//i.test(mimeType || "");
  const isValid = stats.isFile() && stats.size > 0 && stats.size <= MAX_IMAGE_SIZE && isImage;

  return {
    isValid,
    needsReview: true,
    rejectionReason: isValid ? null : "Upload an image file no larger than 5MB.",
    ocrText: null,
    confidence: null,
  };
}

export async function removeKycFile(filePath) {
  await fs.unlink(filePath).catch(() => null);
}
