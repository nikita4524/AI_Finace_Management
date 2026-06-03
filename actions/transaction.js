"use server";

import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { GoogleGenerativeAI } from "@google/generative-ai";
import aj from "@/lib/arcjet";
import { request } from "@arcjet/next";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || "v1";
const FALLBACK_GEMINI_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-1.5-pro";
const FALLBACK_GEMINI_API_VERSION = process.env.GEMINI_FALLBACK_API_VERSION || "v1";

const serializeAmount = (obj) => ({

  ...obj,
  amount: obj.amount.toNumber(),
});

// Create Transaction
export async function createTransaction(data) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    // Get request data for ArcJet
    const req = await request();

    // Check rate limit
    const decision = await aj.protect(req, {
      userId,
      requested: 1, // Specify how many tokens to consume
    });

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        const { remaining, reset } = decision.reason;
        console.error({
          code: "RATE_LIMIT_EXCEEDED",
          details: {
            remaining,
            resetInSeconds: reset,
          },
        });

        throw new Error("Too many requests. Please try again later.");
      }

      throw new Error("Request blocked");
    }

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    const account = await db.account.findUnique({
      where: {
        id: data.accountId,
        userId: user.id,
      },
    });

    if (!account) {
      throw new Error("Account not found");
    }

    // Calculate new balance
    const balanceChange = data.type === "EXPENSE" ? -data.amount : data.amount;
    const newBalance = account.balance.toNumber() + balanceChange;

    // Create transaction and update account balance
    const transaction = await db.$transaction(async (tx) => {
      const newTransaction = await tx.transaction.create({
        data: {
          ...data,
          userId: user.id,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      await tx.account.update({
        where: { id: data.accountId },
        data: { balance: newBalance },
      });

      return newTransaction;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${transaction.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    throw new Error(error.message);
  }
}

export async function getTransaction(id) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  const transaction = await db.transaction.findUnique({
    where: {
      id,
      userId: user.id,
    },
  });

  if (!transaction) throw new Error("Transaction not found");

  return serializeAmount(transaction);
}

export async function updateTransaction(id, data) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) throw new Error("User not found");

    // Get original transaction to calculate balance change
    const originalTransaction = await db.transaction.findUnique({
      where: {
        id,
        userId: user.id,
      },
      include: {
        account: true,
      },
    });

    if (!originalTransaction) throw new Error("Transaction not found");

    // Calculate balance changes
    const oldBalanceChange =
      originalTransaction.type === "EXPENSE"
        ? -originalTransaction.amount.toNumber()
        : originalTransaction.amount.toNumber();

    const newBalanceChange =
      data.type === "EXPENSE" ? -data.amount : data.amount;

    const netBalanceChange = newBalanceChange - oldBalanceChange;

    // Update transaction and account balance in a transaction
    const transaction = await db.$transaction(async (tx) => {
      const updated = await tx.transaction.update({
        where: {
          id,
          userId: user.id,
        },
        data: {
          ...data,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      // Update account balance
      await tx.account.update({
        where: { id: data.accountId },
        data: {
          balance: {
            increment: netBalanceChange,
          },
        },
      });

      return updated;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${data.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    throw new Error(error.message);
  }
}

// Get User Transactions
export async function getUserTransactions(query = {}) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    const transactions = await db.transaction.findMany({
      where: {
        userId: user.id,
        ...query,
      },
      include: {
        account: true,
      },
      orderBy: {
        date: "desc",
      },
    });

    return { success: true, data: transactions };
  } catch (error) {
    throw new Error(error.message);
  }
}

// Scan Receipt
export async function scanReceipt(file) {
  try {
    if (!file || !file.type?.startsWith("image/")) {
      throw new Error("Please upload a valid receipt image.");
    }

    if (!process.env.GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY is not set on the server environment.");
      throw new Error("Server is not configured for receipt scanning (missing GEMINI_API_KEY).");
    }

    // Resolve a generative model robustly: try configured name, fallbacks,
    // and common naming variants to handle SDK/API differences.
    // OCR fallback using free tools (tesseract.js if installed, otherwise tesseract CLI)
    async function ocrFallback(base64String, mimeType) {
      // On Vercel, call the Node API route we added so OCR runs in a Node server runtime.
      try {
        const { headers } = await import("next/headers");
        const headerStore = await headers();
        const host = headerStore.get("host") || "localhost:3000";
        const protocol = process.env.NODE_ENV === "development" ? "http" : "https";
        const url = `${protocol}://${host}/api/ocr`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: base64String, mimeType }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`OCR endpoint error: ${res.status} ${body}`);
        }
        const json = await res.json();
        if (json.text) return json.text;
        throw new Error(json.error || 'Unknown OCR error');
      } catch (e) {
        throw new Error(`OCR service failed: ${e && e.message ? e.message : e}`);
      }
    }
    async function resolveModel(preferredModel, apiVersion, fallbackModel) {
      const attempts = [];
      const candidates = [];

      // primary candidates
      candidates.push({ model: preferredModel, apiVersion });
      candidates.push({ model: preferredModel });

      // try stripping suffixes like -flash or -pro
      const stripped = preferredModel.replace(/-(flash|pro)$/i, "");
      if (stripped !== preferredModel) {
        candidates.push({ model: stripped, apiVersion });
        candidates.push({ model: stripped });
      }

      // variants with explicit models/ prefix
      candidates.push({ model: `models/${preferredModel}`, apiVersion });
      candidates.push({ model: `models/${preferredModel}` });
      if (stripped !== preferredModel) {
        candidates.push({ model: `models/${stripped}`, apiVersion });
        candidates.push({ model: `models/${stripped}` });
      }

      // finally the fallback model
      if (fallbackModel && fallbackModel !== preferredModel) {
        candidates.push({ model: fallbackModel, apiVersion });
        candidates.push({ model: fallbackModel });
      }

      for (const c of candidates) {
        try {
          attempts.push(`try ${JSON.stringify(c)}`);
          return genAI.getGenerativeModel({ model: c.model }, c.apiVersion ? { apiVersion: c.apiVersion } : undefined);
        } catch (err) {
          attempts.push(`failed ${JSON.stringify(c)}: ${err.message}`);
        }
      }

      // If all attempts failed, include any SDK listing if available
      let available;
      try {
        available = await genAI.listModels?.();
      } catch (listErr) {
        available = `Could not list models: ${listErr.message}`;
      }

      const msg = `Configured model '${preferredModel}' is not available. Attempts: ${attempts.join(' | ')}. Available: ${JSON.stringify(available)}`;
      const e = new Error(msg);
      e.attempts = attempts;
      e.available = available;
      throw e;
    }

    let model;
    try {
      model = await resolveModel(GEMINI_MODEL, GEMINI_API_VERSION, FALLBACK_GEMINI_MODEL);
    } catch (mErr) {
      console.error("Error resolving generative model:", mErr.message);
      throw new Error(
        `Configured model '${GEMINI_MODEL}' is not available. Check GEMINI_MODEL and GEMINI_API_VERSION or consult your Google Generative AI account for available models.`
      );
    }

    // Convert File to ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();
    // Convert ArrayBuffer to Base64
    const base64String = Buffer.from(arrayBuffer).toString("base64");

    const prompt = `
      Analyze this receipt image and extract the following information in JSON format.
      Only return valid JSON with no markdown or extra text.
      {
        "amount": number,
        "date": "ISO date string",
        "description": "string",
        "merchantName": "string",
        "category": "string"
      }

      If the image is not a receipt, return exactly:
      {"amount": 0, "date": "", "description": "", "merchantName": "", "category": "other-expense"}
    `;

    let result;
    try {
      result = await model.generateContent([
        {
          inlineData: {
            data: base64String,
            mimeType: file.type,
          },
        },
        prompt,
      ]);
    } catch (initialError) {
      console.warn("Receipt scan failed with configured Gemini model:", GEMINI_MODEL, initialError);
      
      const isAuthError = initialError.message?.includes("API key") || initialError.message?.includes("400");
      
      if (!isAuthError && GEMINI_MODEL !== FALLBACK_GEMINI_MODEL) {
        try {
          const fallbackModel = genAI.getGenerativeModel(
            { model: FALLBACK_GEMINI_MODEL },
            { apiVersion: FALLBACK_GEMINI_API_VERSION }
          );
          console.info(`Retrying receipt scan using fallback model ${FALLBACK_GEMINI_MODEL}`);
          result = await fallbackModel.generateContent([
            {
              inlineData: {
                data: base64String,
                mimeType: file.type,
              },
            },
            prompt,
          ]);
        } catch (fallbackError) {
          console.error("Fallback receipt scan also failed:", fallbackError);
          // Try OCR fallback using free tools (tesseract.js or system tesseract)
          try {
            console.info('Attempting OCR fallback using free tools (tesseract)');
            const ocrText = await ocrFallback(base64String, file.type);
            console.log('OCR result (truncated):', (ocrText || '').slice(0, 1000));

            // Simple parsing heuristics for amount, date, merchant
            const amountMatch = ocrText.match(/(?:total|amount|subtotal|balance)[:\s\$]*([0-9]{1,3}(?:[\.,][0-9]{2,3})*(?:[\.,][0-9]{2})?)/i);
            const dateMatch = ocrText.match(/(\d{4}-\d{2}-\d{2})|(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4})/);
            const lines = ocrText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const merchant = lines.length ? lines[0] : '';

            const parsed = {
              amount: amountMatch ? parseFloat(amountMatch[1].replace(/[,]/g, '')) : 0,
              date: dateMatch ? new Date(dateMatch[0]) : new Date(),
              description: '',
              category: 'other-expense',
              merchantName: merchant,
            };

            return {
              amount: Number.isFinite(Number(parsed.amount)) ? parsed.amount : 0,
              date: parsed.date,
              description: parsed.description,
              category: parsed.category,
              merchantName: parsed.merchantName ?? parsed.merchantName,
            };
          } catch (ocrErr) {
            console.error('OCR fallback failed:', ocrErr);
            throw new Error(
              `Receipt scanning failed for both configured model '${GEMINI_MODEL}' and fallback model '${FALLBACK_GEMINI_MODEL}', and OCR fallback failed: ${ocrErr.message}`
            );
          }
        }
      } else {
        // Auth error or same model, skip to OCR directly
        try {
          console.info('Skipping fallback model due to auth error, attempting OCR fallback directly');
          const ocrText = await ocrFallback(base64String, file.type);
          
          const amountMatch = ocrText.match(/(?:total|amount|subtotal|balance)[:\s\$]*([0-9]{1,3}(?:[\.,][0-9]{2,3})*(?:[\.,][0-9]{2})?)/i);
          const dateMatch = ocrText.match(/(\d{4}-\d{2}-\d{2})|(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4})/);
          const lines = ocrText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          const merchant = lines.length ? lines[0] : '';
          
          const parsed = {
            amount: amountMatch ? parseFloat(amountMatch[1].replace(/[,]/g, '')) : 0,
            date: dateMatch ? new Date(dateMatch[0]) : new Date(),
            description: '',
            category: 'other-expense',
            merchantName: merchant,
          };

          return {
            amount: Number.isFinite(Number(parsed.amount)) ? parsed.amount : 0,
            date: parsed.date,
            description: parsed.description,
            category: parsed.category,
            merchantName: parsed.merchantName ?? parsed.merchantName,
          };
        } catch (ocrErr) {
          throw new Error(`Receipt scanning failed due to auth error, and OCR fallback failed: ${ocrErr.message}`);
        }
      }
    }

    const response = await result.response;
    const text = await response.text();
    // Log raw response for debugging (truncate to avoid huge logs)
    console.log("Receipt scan response raw:", text.slice(0, 2000));
    const cleanedText = text.replace(/```(?:json)?\\n?/g, "").trim();
    // Log cleaned text to help diagnose JSON parsing issues
    console.log("Receipt scan cleaned text:", cleanedText.slice(0, 2000));

    let data;
    try {
      data = JSON.parse(cleanedText);
    } catch (parseError) {
      const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          data = JSON.parse(jsonMatch[0]);
        } catch (nestedParseError) {
          console.error("Failed to parse nested JSON response:", nestedParseError, cleanedText);
          throw new Error("Invalid response format from receipt scanner.");
        }
      } else {
        console.error("Receipt scan response was not valid JSON:", cleanedText);
        throw new Error("Invalid response format from receipt scanner.");
      }
    }

    return {
      amount: Number.isFinite(Number(data.amount)) ? parseFloat(data.amount) : 0,
      date: data.date ? new Date(data.date) : new Date(),
      description: data.description ?? "",
      category: data.category ?? "other-expense",
      merchantName: data.merchantName ?? "",
    };
  } catch (error) {
    console.error("Error scanning receipt:", error);
    throw new Error(error.message || "Failed to scan receipt");
  }
}

// Helper function to calculate next recurring date
function calculateNextRecurringDate(startDate, interval) {
  const date = new Date(startDate);

  switch (interval) {
    case "DAILY":
      date.setDate(date.getDate() + 1);
      break;
    case "WEEKLY":
      date.setDate(date.getDate() + 7);
      break;
    case "MONTHLY":
      date.setMonth(date.getMonth() + 1);
      break;
    case "YEARLY":
      date.setFullYear(date.getFullYear() + 1);
      break;
  }

  return date;
}
