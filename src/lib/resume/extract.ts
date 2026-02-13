import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";

import { getServerEnv } from "@/lib/env";
import { resumeProfileSchema, type ResumeProfile } from "@/lib/resume/schemas";
import { resumeExtractionPrompt } from "@/lib/resume/prompts";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require("pdf-parse") as {
  PDFParse: new (opts: { data: Buffer | Uint8Array }) => {
    getText(): Promise<{ text: string; totalPages: number }>;
    destroy(): Promise<void>;
  };
};

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error("File exceeds 5MB limit");
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = result.text.trim();

    if (!text || text.length < 50) {
      throw new Error("Could not extract meaningful text from PDF. The file may be image-based or empty.");
    }

    return text;
  } finally {
    await parser.destroy();
  }
}

export async function extractResumeProfile(resumeText: string): Promise<ResumeProfile> {
  const env = getServerEnv();

  // Truncate very long resumes to avoid token limits
  const truncated = resumeText.slice(0, 15_000);

  const result = await generateObject({
    model: openai(env.OPENAI_MODEL),
    schema: resumeProfileSchema,
    system: resumeExtractionPrompt,
    prompt: `Here is the resume text to analyze:\n\n${truncated}`,
  });

  return result.object;
}
