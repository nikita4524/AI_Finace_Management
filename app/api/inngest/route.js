import arcjet, { shield, detectBot } from "@arcjet/next";
import { serve } from "inngest/next";

import { inngest } from "@/lib/inngest/client";
import {
  checkBudgetAlerts,
  generateMonthlyReports,
  processRecurringTransaction,
  triggerRecurringTransactions,
} from "@/lib/inngest/function";

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({ mode: "LIVE" }),
    detectBot({ 
      mode: "LIVE",
      allow: ["GO_HTTP"] // Inngest webhook needs this
    }),
  ],
});

// Create the serve handler once
const serveHandler = serve({
  client: inngest,
  functions: [
    processRecurringTransaction,
    triggerRecurringTransactions,
    generateMonthlyReports,
    checkBudgetAlerts,
  ],
});


async function protectedHandler(req) {
  const decision = await aj.protect(req);
  if (decision.isDenied()) {
    return new Response(JSON.stringify({ error: "Security check failed" }), { 
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return serveHandler(req);
}


export const GET = protectedHandler;
export const POST = protectedHandler;
export const PUT = protectedHandler;